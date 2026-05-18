import { getAddress, verifyMessage } from "ethers";

export type AuthNonceRecord = {
  nonce: string;
  account: string;
  message: string;
  domain: string;
  uri: string;
  chainId: number;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
};

export type ApiKeyRecord = {
  id: string;
  tokenHash: string;
  tokenPrefix: string;
  account: string;
  rootAccount: string;
  label?: string;
  scopes: string[];
  status: "active" | "revoked";
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

export type VerifiedApiKey = {
  token: string;
  record: ApiKeyRecord;
};

type KV = Pick<KVNamespace, "get" | "put">;

const NONCE_PREFIX = "auth-nonce:";
const API_KEY_PREFIX = "api-key:";
const ACCOUNT_API_KEYS_PREFIX = "account-api-keys:";

export class AuthStore {
  constructor(private readonly kv: KV) {}

  async createNonce(input: {
    account: string;
    domain: string;
    uri: string;
    chainId?: number;
    ttlSeconds: number;
  }): Promise<AuthNonceRecord> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
    const nonce = randomToken(16);
    const account = normalizeAccount(input.account);
    const chainId = input.chainId ?? 42220;
    const message = buildSignInMessage({
      domain: input.domain,
      uri: input.uri,
      account,
      chainId,
      nonce,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    });
    const record: AuthNonceRecord = {
      nonce,
      account,
      message,
      domain: input.domain,
      uri: input.uri,
      chainId,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    await this.putJson(`${NONCE_PREFIX}${nonce}`, record);
    return record;
  }

  async consumeNonceAndVerify(input: { account: string; nonce: string; signature: string }): Promise<AuthNonceRecord> {
    const record = await this.getJson<AuthNonceRecord>(`${NONCE_PREFIX}${input.nonce}`);
    if (!record) throw new Error("auth nonce not found");
    if (record.consumedAt) throw new Error("auth nonce already consumed");
    if (Date.now() > Date.parse(record.expiresAt)) throw new Error("auth nonce expired");

    const requestedAccount = normalizeAccount(input.account);
    if (record.account !== requestedAccount) throw new Error("auth nonce account mismatch");

    const recovered = normalizeAccount(verifyMessage(record.message, input.signature));
    if (recovered !== requestedAccount) throw new Error("signature does not match account");

    record.consumedAt = new Date().toISOString();
    await this.putJson(`${NONCE_PREFIX}${record.nonce}`, record);
    return record;
  }

  async createApiKey(input: {
    account: string;
    rootAccount?: string;
    label?: string;
    scopes?: string[];
    ttlSeconds?: number;
  }): Promise<{ token: string; record: ApiKeyRecord }> {
    const now = new Date();
    const token = `gd_live_${randomToken(32)}`;
    const tokenHash = await sha256Hex(token);
    const account = normalizeAccount(input.account);
    const rootAccount = normalizeAccount(input.rootAccount ?? input.account);
    const record: ApiKeyRecord = {
      id: crypto.randomUUID(),
      tokenHash,
      tokenPrefix: `${token.slice(0, 12)}...${token.slice(-4)}`,
      account,
      rootAccount,
      label: input.label,
      scopes: input.scopes ?? ["chat:completions"],
      status: "active",
      createdAt: now.toISOString(),
      expiresAt: input.ttlSeconds ? new Date(now.getTime() + input.ttlSeconds * 1000).toISOString() : undefined
    };

    await this.putJson(`${API_KEY_PREFIX}${tokenHash}`, record);
    await this.addApiKeyToAccount(account, record.id);
    if (rootAccount !== account) await this.addApiKeyToAccount(rootAccount, record.id);
    await this.putJson(`${API_KEY_PREFIX}id:${record.id}`, record);
    return { token, record };
  }

  async verifyApiKey(token: string): Promise<VerifiedApiKey | undefined> {
    if (!token.startsWith("gd_live_")) return undefined;
    const tokenHash = await sha256Hex(token);
    const record = await this.getJson<ApiKeyRecord>(`${API_KEY_PREFIX}${tokenHash}`);
    if (!record) return undefined;
    if (record.status !== "active") return undefined;
    if (record.expiresAt && Date.now() > Date.parse(record.expiresAt)) return undefined;
    record.lastUsedAt = new Date().toISOString();
    await this.putJson(`${API_KEY_PREFIX}${tokenHash}`, record);
    await this.putJson(`${API_KEY_PREFIX}id:${record.id}`, record);
    return { token, record };
  }

  async listApiKeys(account: string): Promise<ApiKeyRecord[]> {
    const normalized = normalizeAccount(account);
    const ids = (await this.getJson<string[]>(`${ACCOUNT_API_KEYS_PREFIX}${normalized}`)) ?? [];
    const records = await Promise.all(ids.map((id) => this.getJson<ApiKeyRecord>(`${API_KEY_PREFIX}id:${id}`)));
    return records.filter((record): record is ApiKeyRecord => Boolean(record));
  }

  async revokeApiKey(id: string, account: string): Promise<ApiKeyRecord> {
    const record = await this.getJson<ApiKeyRecord>(`${API_KEY_PREFIX}id:${id}`);
    if (!record) throw new Error("api key not found");
    const normalized = normalizeAccount(account);
    if (record.account !== normalized && record.rootAccount !== normalized) throw new Error("api key does not belong to account");
    record.status = "revoked";
    record.revokedAt = new Date().toISOString();
    await this.putJson(`${API_KEY_PREFIX}id:${id}`, record);
    await this.putJson(`${API_KEY_PREFIX}${record.tokenHash}`, record);
    return record;
  }

  private async addApiKeyToAccount(account: string, id: string): Promise<void> {
    const key = `${ACCOUNT_API_KEYS_PREFIX}${account}`;
    const ids = (await this.getJson<string[]>(key)) ?? [];
    if (!ids.includes(id)) ids.push(id);
    await this.putJson(key, ids.slice(-500));
  }

  private async getJson<T>(key: string): Promise<T | undefined> {
    const value = await this.kv.get(key, "json");
    return (value ?? undefined) as T | undefined;
  }

  private async putJson(key: string, value: unknown): Promise<void> {
    await this.kv.put(key, JSON.stringify(value));
  }
}

export function buildSignInMessage(input: {
  domain: string;
  uri: string;
  account: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  return `${input.domain} wants you to sign in with your Ethereum account:\n${input.account}\n\nSign in to GoodDollar AntSeed to create an API key for local developer tools.\n\nURI: ${input.uri}\nVersion: 1\nChain ID: ${input.chainId}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expiresAt}`;
}

export function bearerToken(request: Request): string | undefined {
  const auth = request.headers.get("authorization");
  if (auth) return auth.replace(/^Bearer\s+/i, "").trim();
  const xApiKey = request.headers.get("x-api-key")?.trim();
  return xApiKey || undefined;
}

export function normalizeAccount(account: string): string {
  return getAddress(account).toLowerCase();
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function randomToken(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((b) => b.toString(16).padStart(2, "0")).join("");
}
