import { RuntimeConfig } from "./env.js";
import { AntSeedChatCompletion, ChatCompletionRequest } from "./types.js";

export class AntSeedClient {
  constructor(private readonly cfg: RuntimeConfig) {}

  async chatCompletion(req: ChatCompletionRequest): Promise<AntSeedChatCompletion> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.ANTSEED_TIMEOUT_MS);

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.ANTSEED_PIN_PEER) headers["x-antseed-pin-peer"] = this.cfg.ANTSEED_PIN_PEER;
    if (this.cfg.ANTSEED_PIN_SERVICE) headers["x-antseed-pin-service"] = this.cfg.ANTSEED_PIN_SERVICE;

    try {
      const res = await fetch(`${this.cfg.ANTSEED_BASE_URL.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: req.model ?? this.cfg.ANTSEED_MODEL,
          messages: req.messages,
          max_tokens: req.max_tokens,
          temperature: req.temperature
        })
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`AntSeed request failed: ${res.status} ${text.slice(0, 500)}`);
      }

      return (await res.json()) as AntSeedChatCompletion;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function providerReceiptHash(response: AntSeedChatCompletion): Promise<string> {
  return sha256Hex(JSON.stringify(response));
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
