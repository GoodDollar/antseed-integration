import express from "express";
import pino from "pino";
import { z } from "zod";
import { Config } from "./config.js";
import { actualCostMicroUsd, estimateMaxCostMicroUsd } from "./pricing.js";
import { CreditLedger } from "./credit-ledger.js";
import { AntSeedClient, providerReceiptHash } from "./antseed-client.js";
import { VaultClient } from "./vault-client.js";

const ChatSchema = z.object({
  account: z.string().min(1),
  model: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string()
  })).min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  metadata: z.record(z.unknown()).optional()
});

export function createServer(cfg: Config) {
  const app = express();
  const logger = pino({ level: cfg.LOG_LEVEL });
  const ledger = new CreditLedger();
  const antseed = new AntSeedClient(cfg);
  const vault = new VaultClient(cfg);

  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      logger.info({ method: req.method, url: req.url, statusCode: res.statusCode, durationMs: Date.now() - started }, "request");
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "gooddollar-antseed-integration", vaultEnabled: vault.enabled });
  });

  app.get("/v1/accounts/:account/credit", async (req, res, next) => {
    try {
      const balances = await vault.balances(req.params.account);
      res.json({ account: req.params.account, vault: balances, localReservations: ledger.byAccount(req.params.account) });
    } catch (err) {
      next(err);
    }
  });

  app.post("/v1/credits/quote", (req, res) => {
    const parsed = ChatSchema.pick({ messages: true, max_tokens: true }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const maxCostMicroUsd = estimateMaxCostMicroUsd(cfg, parsed.data.messages, parsed.data.max_tokens);
    res.json({ maxCostMicroUsd: maxCostMicroUsd.toString() });
  });

  app.post("/v1/chat/completions", async (req, res, next) => {
    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const body = parsed.data;
    const maxCostMicroUsd = estimateMaxCostMicroUsd(cfg, body.messages, body.max_tokens);
    const reservation = ledger.reserve(body.account, maxCostMicroUsd);

    try {
      await vault.reserve(reservation.requestId, body.account, maxCostMicroUsd, body.metadata);
      const completion = await antseed.chatCompletion(body);
      const receiptHash = providerReceiptHash(completion);
      const cost = actualCostMicroUsd(
        cfg,
        completion.usage?.prompt_tokens,
        completion.usage?.completion_tokens
      );
      ledger.settle(reservation.requestId, cost, receiptHash);
      await vault.settle(reservation.requestId, cost, receiptHash);

      res.json({
        ...completion,
        credit: {
          requestId: reservation.requestId,
          reservedMicroUsd: maxCostMicroUsd.toString(),
          settledMicroUsd: cost.toString(),
          providerReceiptHash: receiptHash,
          vaultEnabled: vault.enabled
        }
      });
    } catch (err) {
      ledger.release(reservation.requestId);
      try {
        await vault.release(reservation.requestId);
      } catch (releaseErr) {
        logger.warn({ err: releaseErr, requestId: reservation.requestId }, "failed to release vault reservation");
      }
      next(err);
    }
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : "unknown error";
    logger.error({ err }, message);
    res.status(500).json({ error: message });
  });

  return app;
}
