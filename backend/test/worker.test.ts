import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import worker, { accountSelectorFromRequest } from "../src/worker.js";
import { Env } from "../src/env.js";

class MemoryKV {
  private data = new Map<string, string>();

  async get(key: string, type?: "text" | "json") {
    const raw = this.data.get(key) ?? null;
    if (type === "json") return raw ? JSON.parse(raw) : null;
    return raw;
  }

  async put(key: string, value: string) {
    this.data.set(key, value);
  }
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    ANTSEED_KV: new MemoryKV() as never,
    ANTSEED_BASE_URL: "https://antseed.example",
    ANTSEED_MODEL: "qwen3-235b-instruct",
    ...overrides
  } as Env;
}

type SigningWallet = { address: string; signMessage(message: string): Promise<string> };

async function issueApiKey(testEnv: Env, wallet: SigningWallet): Promise<{ token: string; apiKey: { id: string; account: string; rootAccount: string } }> {
  const nonceRes = await worker.fetch(new Request("https://worker.test/v1/auth/nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: wallet.address })
  }), testEnv, {} as ExecutionContext);
  assert.equal(nonceRes.status, 201);
  const nonceBody = await nonceRes.json() as { nonce: string; message: string; account: string };
  assert.equal(nonceBody.account, wallet.address.toLowerCase());

  const signature = await wallet.signMessage(nonceBody.message);
  const keyRes = await worker.fetch(new Request("https://worker.test/v1/auth/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: wallet.address, nonce: nonceBody.nonce, signature, label: "tests" })
  }), testEnv, {} as ExecutionContext);
  assert.equal(keyRes.status, 201);
  return await keyRes.json() as { token: string; apiKey: { id: string; account: string; rootAccount: string } };
}

test("dev-only account selector can parse body, x-gooddollar-account, Authorization, or x-api-key", () => {
  const wallet = "0x0000000000000000000000000000000000000abc";
  assert.equal(accountSelectorFromRequest(new Request("https://worker.test/v1/chat/completions"), wallet), wallet);
  assert.equal(accountSelectorFromRequest(new Request("https://worker.test/v1/chat/completions", { headers: { "x-gooddollar-account": wallet } })), wallet);
  assert.equal(accountSelectorFromRequest(new Request("https://worker.test/v1/chat/completions", { headers: { authorization: `Bearer gd:${wallet}` } })), wallet);
  assert.equal(accountSelectorFromRequest(new Request("https://worker.test/v1/chat/completions", { headers: { "x-api-key": `account:${wallet}` } })), wallet);
});

test("config status documents signed API-key backend proxy flow", async () => {
  const res = await worker.fetch(new Request("https://worker.test/config/status"), env(), {} as ExecutionContext);
  assert.equal(res.status, 200);
  const body = await res.json() as {
    openAiCompatible: { chatCompletionsPath: string; auth: string; accountSelectors: string[]; devOnlyAccountSelectorsEnabled: boolean };
    antseed: { model: string; baseUrlConfigured: boolean; fundingVaultEnabled: boolean; fundingModel: string };
  };
  assert.equal(body.openAiCompatible.chatCompletionsPath, "/v1/chat/completions");
  assert.equal(body.openAiCompatible.accountSelectors.includes("Authorization: Bearer gd_live_..."), true);
  assert.equal(body.openAiCompatible.devOnlyAccountSelectorsEnabled, false);
  assert.match(body.openAiCompatible.auth, /signed wallet/);
  assert.equal(body.antseed.model, "qwen3-235b-instruct");
  assert.equal(body.antseed.baseUrlConfigured, true);
  assert.equal(body.antseed.fundingVaultEnabled, false);
  assert.match(body.antseed.fundingModel, /backend-controlled Base USDC vault/);
});

test("wallet signature issues API key and imposter signature is rejected", async () => {
  const testEnv = env();
  const owner = Wallet.createRandom();
  const imposter = Wallet.createRandom();

  const nonceRes = await worker.fetch(new Request("https://worker.test/v1/auth/nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: owner.address })
  }), testEnv, {} as ExecutionContext);
  const nonceBody = await nonceRes.json() as { nonce: string; message: string };
  const badSignature = await imposter.signMessage(nonceBody.message);

  const badKeyRes = await worker.fetch(new Request("https://worker.test/v1/auth/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: owner.address, nonce: nonceBody.nonce, signature: badSignature })
  }), testEnv, {} as ExecutionContext);
  assert.equal(badKeyRes.status, 401);

  const good = await issueApiKey(testEnv, owner);
  assert.match(good.token, /^gd_live_/);
  assert.equal(good.apiKey.account, owner.address.toLowerCase());
  assert.equal(good.apiKey.rootAccount, owner.address.toLowerCase());
});

test("chat completions require issued API key by default", async () => {
  const testEnv = env();
  const wallet = Wallet.createRandom();
  await worker.fetch(new Request("https://worker.test/v1/celo/deposits/manual", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: wallet.address, gdAmountWei: "1000000000000000000", source: "manual" })
  }), testEnv, {} as ExecutionContext);

  const res = await worker.fetch(new Request("https://worker.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer gd:${wallet.address}`
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] })
  }), testEnv, {} as ExecutionContext);
  assert.equal(res.status, 401);
});

test("chat completions reserve GoodDollar credits, call AntSeed through backend, then settle", async () => {
  const testEnv = env();
  const wallet = Wallet.createRandom();
  const { token } = await issueApiKey(testEnv, wallet);

  const creditRes = await worker.fetch(new Request("https://worker.test/v1/celo/deposits/manual", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account: wallet.address,
      gdAmountWei: "1000000000000000000",
      source: "manual"
    })
  }), testEnv, {} as ExecutionContext);
  assert.equal(creditRes.status, 200);

  const previousFetch = globalThis.fetch;
  let antseedCalled = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://antseed.example/v1/chat/completions") {
      antseedCalled = true;
      assert.equal(init?.method, "POST");
      const upstream = JSON.parse(String(init?.body));
      assert.equal(upstream.model, "qwen3-235b-instruct");
      assert.deepEqual(upstream.messages, [{ role: "user", content: "hello" }]);
      return Response.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: upstream.model,
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      });
    }
    return previousFetch(input as never, init);
  }) as typeof fetch;

  try {
    const chatRes = await worker.fetch(new Request("https://worker.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        model: "qwen3-235b-instruct",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 64
      })
    }), testEnv, {} as ExecutionContext);

    assert.equal(chatRes.status, 200);
    const chat = await chatRes.json() as { choices: unknown[]; credit: { settledMicroUsd: string; vaultEnabled: boolean; antseedFunding: { enabled: boolean; requiredMicroUsd: string } } };
    assert.equal(antseedCalled, true);
    assert.equal(chat.choices.length, 1);
    assert.equal(chat.credit.settledMicroUsd, "35");
    assert.equal(chat.credit.vaultEnabled, false);
    assert.equal(chat.credit.antseedFunding.enabled, false);
    assert.equal(chat.credit.antseedFunding.requiredMicroUsd, "1000");

    const profileRes = await worker.fetch(new Request(`https://worker.test/v1/accounts/${wallet.address}/credit`), testEnv, {} as ExecutionContext);
    const profile = await profileRes.json() as { profile: { totalRequests: number; totalSettledMicroUsd: string; creditBalanceMicroUsd: string } };
    assert.equal(profile.profile.totalRequests, 1);
    assert.equal(profile.profile.totalSettledMicroUsd, "35");
    assert.equal(profile.profile.creditBalanceMicroUsd, "1099965");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("revoked API key cannot spend credits", async () => {
  const testEnv = env();
  const wallet = Wallet.createRandom();
  const { token, apiKey } = await issueApiKey(testEnv, wallet);

  const revokeRes = await worker.fetch(new Request(`https://worker.test/v1/auth/api-keys/${apiKey.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` }
  }), testEnv, {} as ExecutionContext);
  assert.equal(revokeRes.status, 200);

  const chatRes = await worker.fetch(new Request("https://worker.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] })
  }), testEnv, {} as ExecutionContext);
  assert.equal(chatRes.status, 401);
});
