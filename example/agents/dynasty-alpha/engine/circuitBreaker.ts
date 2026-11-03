import type { AgentObservation } from "@eris/sdk";
import type { Tuning } from "../StrategyTuning.js";

export type BreakerStatus = {
  tripped: boolean;
  reason: string | null;
};

export class CircuitBreaker {
  private trippedUntilBlock = -1;
  private lastTrippedSampleRound = -1;
  private prevEthWei: bigint | null = null;
  private prevTotalEth: number | null = null;
  private prevWbtc: number | null = null;
  private prevValueUsdc: number | null = null;
  private prevFairWeth: number | null = null;
  private prevFairWbtc: number | null = null;
  private cumulativeGasUsd = 0;
  private cumulativeGrossProfitUsd = 0;

  check(
    round: number,
    params: Tuning,
    obs?: AgentObservation,
  ): BreakerStatus {
    if (round < this.trippedUntilBlock) {
      return {
        tripped: true,
        reason: `circuit breaker cooldown until block ${this.trippedUntilBlock}`,
      };
    }

    // 1. Check rolling revert / slippage spike
    const comp = obs?.competition;
    if (
      comp &&
      typeof comp.recentSampleSize === "number" &&
      comp.recentSampleSize >= 4 &&
      typeof comp.recentRevertRate === "number" &&
      comp.recentRevertRate > params.breaker.maxRevertRate &&
      params.breaker.cooldownBlocks > 0 &&
      round > this.lastTrippedSampleRound
    ) {
      this.lastTrippedSampleRound = round + params.breaker.cooldownBlocks;
      this.trip(round, params.breaker.cooldownBlocks);
      return {
        tripped: true,
        reason: `circuit breaker tripped: recentRevertRate=${(comp.recentRevertRate * 100).toFixed(0)}% > ${(params.breaker.maxRevertRate * 100).toFixed(0)}%`,
      };
    }

    // 2. Check rolling gas cost vs realized delta-neutral trading profit ratio
    if (obs?.balances?.ethWei && obs.inventory && Number.isFinite(obs.inventory.valueUsdc)) {
      const ethNow = BigInt(obs.balances.ethWei);
      const wethNow = BigInt(obs.balances.wethWei || "0");
      const lstWethNow = BigInt(obs.protocols?.lst?.lstRedemptionValueWethWei || "0") +
        BigInt(obs.protocols?.lst?.pendingWithdrawalWethWei || "0") +
        BigInt(obs.protocols?.lst?.claimableWithdrawalWethWei || "0");
      const totalEthNow = Number(ethNow + wethNow + lstWethNow) / 1e18;
      const wbtcNow = Number(BigInt(obs.baseBalances?.WBTC || "0")) / 1e8;
      const valNow = obs.inventory.valueUsdc;
      const fair = Number.isFinite(obs.fairPriceUsdcPerWeth)
        ? obs.fairPriceUsdcPerWeth
        : 3000;
      const fairWbtc = obs.fairPricesUsd?.WBTC ?? 60_000;

      if (
        this.prevEthWei !== null &&
        this.prevTotalEth !== null &&
        this.prevWbtc !== null &&
        this.prevValueUsdc !== null &&
        this.prevFairWeth !== null &&
        this.prevFairWbtc !== null
      ) {
        // Single-block ETH drop <= 0.03 ETH is gas; larger drop is WETH9.deposit() wrap
        const ethDiff = ethNow < this.prevEthWei ? this.prevEthWei - ethNow : 0n;
        const stepGasEth = ethDiff > 0n && ethDiff <= 30_000_000_000_000_000n ? Number(ethDiff) / 1e18 : 0;
        const stepGasUsd = stepGasEth * fair;
        const passiveBetaUsd =
          this.prevTotalEth * (fair - this.prevFairWeth) +
          this.prevWbtc * (fairWbtc - this.prevFairWbtc);
        const stepGrossProfitUsd = (valNow - this.prevValueUsdc) - passiveBetaUsd + stepGasUsd;

        if (stepGasUsd > 0 || Math.abs(stepGrossProfitUsd) > 0.05) {
          this.cumulativeGasUsd += stepGasUsd;
          this.cumulativeGrossProfitUsd += stepGrossProfitUsd;
        }
      }

      this.prevEthWei = ethNow;
      this.prevTotalEth = totalEthNow;
      this.prevWbtc = wbtcNow;
      this.prevValueUsdc = valNow;
      this.prevFairWeth = fair;
      this.prevFairWbtc = fairWbtc;

      if (
        this.cumulativeGasUsd >= 15 &&
        params.breaker.cooldownBlocks > 0 &&
        round > this.lastTrippedSampleRound
      ) {
        const effectiveProfit = Math.max(0.01, this.cumulativeGrossProfitUsd);
        const gasToProfitRatio = this.cumulativeGasUsd / effectiveProfit;
        if (gasToProfitRatio > params.breaker.maxGasToProfitRatio) {
          const reportedGas = this.cumulativeGasUsd;
          const reportedProfit = this.cumulativeGrossProfitUsd;
          this.lastTrippedSampleRound = round + params.breaker.cooldownBlocks;
          this.cumulativeGasUsd = 0;
          this.cumulativeGrossProfitUsd = 0;
          this.trip(round, params.breaker.cooldownBlocks);
          return {
            tripped: true,
            reason: `circuit breaker tripped: gasToProfitRatio=${gasToProfitRatio.toFixed(2)} > ${params.breaker.maxGasToProfitRatio} (gas=$${reportedGas.toFixed(2)}, profit=$${reportedProfit.toFixed(2)})`,
          };
        }
      }
    }

    return { tripped: false, reason: null };
  }

  trip(currentRound: number, cooldownBlocks: number): void {
    this.trippedUntilBlock = currentRound + Math.max(0, cooldownBlocks);
  }
}
