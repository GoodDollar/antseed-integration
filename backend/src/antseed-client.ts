import { createHash } from "node:crypto";
import { Config } from "./config.js";
import { AntSeedChatCompletion, ChatCompletionRequest } from "./types.js";

export class AntSeedClient {
  constructor(private readonly cfg: Config) {}

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

export function providerReceiptHash(response: AntSeedChatCompletion): string {
  return `0x${createHash("sha256").update(JSON.stringify(response)).digest("hex")}`;
}
