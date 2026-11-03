import { z } from "zod";

export const REGIMES = [
  "calm",
  "cex-drift",
  "informed-flow",
  "whale",
  "lending-incident",
  "crash",
  "depeg",
  "vuln",
  "spike",
  "depeg-persist",
  "cdp-incident",
  "launch",
  "unknown",
] as const;

export type RegimeId = (typeof REGIMES)[number];

export const TuningSchema = z
  .object({
    schemaVersion: z.literal(1),
    regime: z.enum(REGIMES),
    weights: z
      .object({
        ammArb: z.number().min(0).max(1),
        pegArb: z.number().min(0).max(1),
        liquidation: z.number().min(0).max(1),
      })
      .strict(),
    ammArb: z
      .object({
        minGapBps: z.number().min(5).max(500),
        sizeBps: z.number().int().min(50).max(5000),
        slippageBps: z.number().int().min(10).max(300),
        priorityFeeMult: z.number().min(1).max(20),
      })
      .strict(),
    pegArb: z
      .object({
        minDiscountBps: z.number().min(20).max(1000),
        sizeBps: z.number().int().min(50).max(5000),
        slippageBps: z.number().int().min(10).max(300),
        maxRedemptionFeeBps: z.number().min(50).max(500),
      })
      .strict(),
    liquidation: z
      .object({
        maxHealthFactor: z.number().min(0.5).max(1.0),
        minBonusBps: z.number().min(100).max(2000),
        priorityFeeMult: z.number().min(1).max(50),
      })
      .strict(),
    breaker: z
      .object({
        maxGasToProfitRatio: z.number().min(0.1).max(10),
        maxRevertRate: z.number().min(0).max(1),
        cooldownBlocks: z.number().int().min(0).max(120),
      })
      .strict(),
  })
  .strict();

export type Tuning = z.infer<typeof TuningSchema>;

export const DEFAULT_PARAMS: Tuning = {
  schemaVersion: 1,
  regime: "unknown",
  weights: {
    ammArb: 1,
    pegArb: 0,
    liquidation: 0,
  },
  ammArb: {
    minGapBps: 12,
    sizeBps: 1000,
    slippageBps: 50,
    priorityFeeMult: 1,
  },
  pegArb: {
    minDiscountBps: 85,
    sizeBps: 500,
    slippageBps: 50,
    maxRedemptionFeeBps: 150,
  },
  liquidation: {
    maxHealthFactor: 0.995,
    minBonusBps: 300,
    priorityFeeMult: 5,
  },
  breaker: {
    maxGasToProfitRatio: 0.35,
    maxRevertRate: 0.35,
    cooldownBlocks: 12,
  },
};

/**
 * Hard-coded runtime safety clamps against LLM parameter tampering at block 60+.
 * Even if `gpt-oss:120b` mutates `const PARAMS = { ... }` in `executorTs` to disable
 * the circuit breaker or widen slippage, this function enforces immutable bounds.
 */
export function clampSafetyParams(params: Tuning): Tuning {
  return {
    ...params,
    ammArb: {
      ...params.ammArb,
      minGapBps: Math.max(params.ammArb.minGapBps, 12),
      slippageBps: Math.min(params.ammArb.slippageBps, 50),
    },
    breaker: {
      ...params.breaker,
      maxGasToProfitRatio: Math.min(params.breaker.maxGasToProfitRatio, 0.35),
      maxRevertRate: Math.min(params.breaker.maxRevertRate, 0.35),
    },
  };
}

export type ValidationResult =
  | { ok: true; params: Tuning }
  | { ok: false; reason: string };

export function validateParams(raw: unknown): ValidationResult {
  const parsed = TuningSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return {
      ok: false,
      reason: `invalid strategy params (${path}${issue?.message ?? "schema check failed"})`,
    };
  }
  return { ok: true, params: parsed.data };
}

export const TUNING_SCHEMA_DOC = [
  "schemaVersion: 1 (literal)",
  `regime: one of ${REGIMES.map((r) => `"${r}"`).join(" | ")}`,
  "weights: { ammArb: 0..1, pegArb: 0..1, liquidation: 0..1 }",
  "ammArb: { minGapBps: 5..500, sizeBps: int 50..5000, slippageBps: int 10..300, priorityFeeMult: 1..20 }",
  "pegArb: { minDiscountBps: 20..1000, sizeBps: int 50..5000, slippageBps: int 10..300, maxRedemptionFeeBps: 50..500 }",
  "liquidation: { maxHealthFactor: 0.5..1.0, minBonusBps: 100..2000, priorityFeeMult: 1..50 }",
  "breaker: { maxGasToProfitRatio: 0.1..10, maxRevertRate: 0..1, cooldownBlocks: int 0..120 }",
].join("\n");
