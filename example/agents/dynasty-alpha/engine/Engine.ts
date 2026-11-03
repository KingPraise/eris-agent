import type { AgentAction, AgentObservation } from "@eris/sdk";
import {
  evaluateAmmArb,
  type ModuleCandidate,
} from "../modules/ammArb.js";
import { evaluateLiquidation } from "../modules/liquidation.js";
import { evaluateEndOfEpochUnwind } from "../modules/lstAndDiscovery.js";
import { evaluatePegArb } from "../modules/pegArb.js";
import { clampSafetyParams, type RegimeId, type Tuning } from "../StrategyTuning.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { ParamsLoader } from "./params.js";
import { TelemetryLogger } from "./telemetry.js";
import { verifyActionWhitelist } from "./whitelist.js";

export type EngineContext = {
  log?: (entry: {
    reason: string;
    signals?: Record<string, number>;
    state?: Record<string, unknown>;
  }) => void;
};

export class Engine {
  private readonly paramsLoader = new ParamsLoader();
  private readonly breaker = new CircuitBreaker();
  private readonly telemetry = new TelemetryLogger();

  constructor(private readonly customParamsPath?: string) {}

  classifyRegime(obs: AgentObservation, params: Tuning): RegimeId {
    if (params.regime !== "unknown") {
      return params.regime;
    }
    const liq = obs.protocols?.liquity;
    if (
      liq &&
      (liq.recoveryMode ||
        liq.discountBps >= 80 ||
        (liq.riskiestTrove && liq.riskiestTrove.icr < liq.mcr))
    ) {
      return "cdp-incident";
    }
    const stables = obs.balances?.stables ?? {};
    for (const [sym, s] of Object.entries(stables)) {
      if (sym !== "USDC" && s.marketQuoted && s.priceUsdc < 0.992) {
        return "depeg";
      }
    }
    if (obs.discoveredPools && obs.discoveredPools.length > 0) {
      return "launch";
    }
    if (
      obs.registry?.entries?.some(
        (e) => e.kind === "uniswapV3Pool" || e.kind === "erc20",
      )
    ) {
      return "launch";
    }
    if (obs.registry?.entries?.some((e) => !e.verified)) {
      return "vuln";
    }
    const rawHf = obs.protocols?.aave?.healthFactor ?? "";
    const aaveHf = rawHf.includes(".")
      ? Number(rawHf)
      : Number(rawHf) / 1e18;
    if (Number.isFinite(aaveHf) && aaveHf > 0 && aaveHf < 1.0) {
      return "lending-incident";
    }
    const p = obs.protocols ?? {};
    const prices = [
      p.uniswap?.pool?.priceUsdcPerWeth,
      p.balancer?.priceUsdcPerWeth,
      p.curve?.priceUsdcPerWeth,
    ].filter((x): x is number => typeof x === "number" && x > 0);
    if (prices.length >= 2) {
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      if ((maxP / minP - 1) * 10_000 >= 250) {
        return "whale";
      }
    }
    return "calm";
  }

  /**
   * Computes effective module weights by combining `params.weights` with online regime detection
   * when `params.regime === "unknown"`. When `params.regime !== "unknown"`, respects explicit `params.weights`
   * while ensuring critical venues (`cdp-incident`, `depeg`, `lending-incident`, `lst`) are active.
   */
  private resolveEffectiveWeights(
    obs: AgentObservation,
    params: Tuning,
    detectedRegime: RegimeId,
  ): Tuning["weights"] {
    // If the user or LLM explicitly set a regime in strategy-params.json, honor params.weights directly
    if (params.regime !== "unknown") {
      return params.weights;
    }

    const w = { ...params.weights };
    if (detectedRegime === "cdp-incident") {
      w.pegArb = Math.max(w.pegArb, 1.0);
      w.liquidation = Math.max(w.liquidation, 1.0);
    } else if (detectedRegime === "depeg") {
      w.pegArb = Math.max(w.pegArb, 1.0);
    } else if (detectedRegime === "lending-incident") {
      w.liquidation = Math.max(w.liquidation, 1.0);
    }

    // Activate pegArb when LST venue has actionable claim/discount/premium or verified registry lending exists
    const lst = obs.protocols?.lst;
    if (
      lst &&
      (BigInt(lst.claimableWithdrawalWethWei || "0") > 0n ||
        Math.abs(lst.discountBps) > 27)
    ) {
      w.pegArb = Math.max(w.pegArb, 0.9);
    }
    if (obs.protocols?.lending?.markets?.length) {
      w.pegArb = Math.max(w.pegArb, 0.8);
    }
    return w;
  }

  step(obs: AgentObservation, ctx?: EngineContext): AgentAction {
    const t0 = performance.now();
    try {
      if (!obs || typeof obs !== "object" || !obs.balances || !obs.limits) {
        return { type: "noop", reason: "malformed observation" };
      }

      const { params: rawParams } = this.paramsLoader.load(this.customParamsPath);
      const params = clampSafetyParams(rawParams);
      const regime = this.classifyRegime(obs, params);
      const round = typeof obs.round === "number" ? obs.round : 0;

      // 0. End-of-Epoch Unwind Guard (`blocksRemaining <= 15`) runs BEFORE circuit breaker
      //    so we never leave stranded registry lending / launch positions at the final block!
      const unwindCand = evaluateEndOfEpochUnwind(obs, params);
      if (unwindCand) {
        const check = verifyActionWhitelist(unwindCand.action, obs);
        if (check.ok) {
          this.recordStep(
            obs,
            regime,
            unwindCand.module,
            unwindCand.action.type,
            unwindCand.reason,
            unwindCand.expectedEdgeBps,
            t0,
            false,
            ctx,
          );
          return unwindCand.action;
        }
      }

      const breakerState = this.breaker.check(round, params, obs);
      if (breakerState.tripped) {
        const reason = breakerState.reason ?? "circuit breaker active";
        this.recordStep(obs, regime, "none", "noop", reason, 0, t0, true, ctx);
        return { type: "noop", reason };
      }

      const effectiveWeights = this.resolveEffectiveWeights(obs, params, regime);
      const effectiveParams: Tuning =
        params.regime === "unknown" && regime !== "calm"
          ? { ...params, regime, weights: effectiveWeights }
          : { ...params, weights: effectiveWeights };

      const candidates: ModuleCandidate[] = [];
      let ammNoopReason = "no fundable gap worth taking";

      if (effectiveWeights.ammArb > 0) {
        const amm = evaluateAmmArb(obs, effectiveParams);
        ammNoopReason = amm.noopReason;
        if (amm.candidate) candidates.push(amm.candidate);
      }
      if (effectiveWeights.pegArb > 0) {
        const peg = evaluatePegArb(obs, effectiveParams);
        if (peg) candidates.push(peg);
      }
      if (effectiveWeights.liquidation > 0) {
        const liq = evaluateLiquidation(obs, effectiveParams);
        if (liq) candidates.push(liq);
      }

      if (candidates.length === 0) {
        this.recordStep(
          obs,
          regime,
          "none",
          "noop",
          ammNoopReason,
          0,
          t0,
          false,
          ctx,
        );
        return { type: "noop", reason: ammNoopReason };
      }

      // Rank candidates by expectedEdgeBps * effective module weight
      candidates.sort((a, b) => {
        const scoreA = a.expectedEdgeBps * effectiveWeights[a.module];
        const scoreB = b.expectedEdgeBps * effectiveWeights[b.module];
        return scoreB - scoreA;
      });

      for (const chosen of candidates) {
        const check = verifyActionWhitelist(chosen.action, obs);
        if (!check.ok) {
          continue;
        }
        this.recordStep(
          obs,
          regime,
          chosen.module,
          chosen.action.type,
          chosen.reason,
          chosen.expectedEdgeBps,
          t0,
          false,
          ctx,
        );
        return chosen.action;
      }

      const blockedReason = "all candidate actions blocked by whitelist";
      this.recordStep(
        obs,
        regime,
        "none",
        "noop",
        blockedReason,
        0,
        t0,
        false,
        ctx,
      );
      return { type: "noop", reason: blockedReason };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { type: "noop", reason: `engine fallback: ${msg}` };
    }
  }

  private recordStep(
    obs: AgentObservation,
    regime: RegimeId,
    module: "ammArb" | "pegArb" | "liquidation" | "none",
    actionType: string,
    reason: string,
    expectedEdgeBps: number,
    t0: number,
    breakerTripped: boolean,
    ctx?: EngineContext,
  ): void {
    const latencyMs = Math.max(0, performance.now() - t0);
    const round = typeof obs.round === "number" ? obs.round : 0;
    const fair = Number.isFinite(obs.fairPriceUsdcPerWeth)
      ? obs.fairPriceUsdcPerWeth
      : 0;
    this.telemetry.record({
      ts: new Date().toISOString(),
      round,
      blocksRemaining: obs.blocksRemaining,
      regime,
      module,
      actionType,
      reason,
      expectedEdgeBps,
      fairPriceUsdcPerWeth: fair,
      latencyMs,
      breakerTripped,
    });
    ctx?.log?.({
      reason,
      signals: {
        expectedEdgeBps,
        latencyMs,
      },
      state: {
        regime,
        module,
        breakerTripped,
      },
    });
  }
}
