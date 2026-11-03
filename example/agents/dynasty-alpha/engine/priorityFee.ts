import type { AgentObservation } from "@eris/sdk";
import type { Tuning } from "../StrategyTuning.js";

const ONE_GWEI = 1_000_000_000n;
export const SINGLE_LEG_GAS_UNITS = 180_000n;
export const TWO_LEG_GAS_UNITS = 360_000n;
export const BASE_FEE_PER_GAS_WEI = 100_000_000n; // 0.10 gwei L2 base fee estimate
export const MIN_ANTI_FRONTRUN_FLOOR_WEI = 50_000_000n; // 0.05 gwei minimal anti-frontrun floor
export const MIN_NET_PROFIT_USD = 3.0; // $3.00 minimum net profit after gas
export const MAX_GAS_TO_PROFIT_SHARE = 0.2; // 20% hard cap on total gas cost / expected profit

// Cap proactive total gas (base + priority) at 19.5% of expected trade profit so it stays strictly <= 20% EV gate
const MAX_PROFIT_SHARE_BPS = 1950n;
const KEEPER_SPIKE_THRESHOLD_WEI = 35_000_000_000n; // >= 35 gwei indicates non-AMM keeper (e.g. 50 gwei GMX OrderHandler)

export function scalePriorityFee(defaultFeeWei: string, mult: number): string {
  const base = BigInt(defaultFeeWei || "0");
  if (mult === 1) return base.toString();
  const scaledBps = BigInt(Math.max(100, Math.round(mult * 100)));
  return ((base * scaledBps) / 100n).toString();
}

/**
 * Estimates total transaction gas cost in USD:
 * `(baseFeePerGas + priorityFeePerGas) * estimatedGasUnits * fairPriceUsdcPerWeth`
 */
export function estimateGasCostUsd(
  priorityFeeWei: string | bigint,
  gasUnits: bigint = SINGLE_LEG_GAS_UNITS,
  fairPriceUsdcPerWeth = 3000,
  baseFeePerGasWei: bigint = BASE_FEE_PER_GAS_WEI,
): number {
  const fair =
    Number.isFinite(fairPriceUsdcPerWeth) && fairPriceUsdcPerWeth > 0
      ? fairPriceUsdcPerWeth
      : 3000;
  const prio =
    typeof priorityFeeWei === "bigint"
      ? priorityFeeWei
      : BigInt(priorityFeeWei || "0");
  const totalGasWei = (baseFeePerGasWei + prio) * gasUnits;
  return (Number(totalGasWei) / 1e18) * fair;
}

/**
 * Strict Net-of-Gas EV Gate:
 * Requires `expectedProfitUsd - estimatedGasCostUsd >= $3.00` AND
 * `estimatedGasCostUsd <= expectedProfitUsd * 0.20`.
 */
export function passesNetEvGate(
  expectedProfitUsd: number,
  priorityFeeWei: string | bigint,
  gasUnits: bigint = SINGLE_LEG_GAS_UNITS,
  fairPriceUsdcPerWeth = 3000,
  baseFeePerGasWei: bigint = BASE_FEE_PER_GAS_WEI,
): boolean {
  if (
    !Number.isFinite(expectedProfitUsd) ||
    expectedProfitUsd < MIN_NET_PROFIT_USD
  ) {
    return false;
  }
  const estimatedGasCostUsd = estimateGasCostUsd(
    priorityFeeWei,
    gasUnits,
    fairPriceUsdcPerWeth,
    baseFeePerGasWei,
  );
  return (
    expectedProfitUsd - estimatedGasCostUsd >= MIN_NET_PROFIT_USD &&
    estimatedGasCostUsd <= expectedProfitUsd * MAX_GAS_TO_PROFIT_SHARE
  );
}

/**
 * Returns the maximum profitable priority fee per gas unit (in wei) for a given expected USD profit,
 * bounded at 15% of expected profit (and strictly below the 20% total gas ceiling after baseFee).
 */
export function maxProfitablePriorityFeeWei(
  expectedProfitUsd: number,
  fairPriceUsdcPerWeth: number,
  gasUnits: bigint = SINGLE_LEG_GAS_UNITS,
): bigint {
  if (gasUnits <= 0n || !Number.isFinite(expectedProfitUsd) || expectedProfitUsd <= 0) {
    return 0n;
  }
  const fair =
    Number.isFinite(fairPriceUsdcPerWeth) && fairPriceUsdcPerWeth > 0
      ? fairPriceUsdcPerWeth
      : 3000;
  const profitWei =
    BigInt(Math.max(0, Math.floor((expectedProfitUsd / fair) * 1e9))) * ONE_GWEI;
  const totalGasCeilingPerGas = (profitWei * MAX_PROFIT_SHARE_BPS) / 10_000n / gasUnits;
  return totalGasCeilingPerGas > BASE_FEE_PER_GAS_WEI
    ? totalGasCeilingPerGas - BASE_FEE_PER_GAS_WEI
    : 0n;
}

/**
 * True when an observed competitor (`obs.competition.maxCompetitorPriorityFeeWei`) is bidding
 * strictly above our EV priority fee ceiling (e.g. a 50 gwei keeper/whale).
 */
export function isRivalAboveEvCeiling(
  obs: AgentObservation,
  expectedProfitUsd: number,
  gasUnits: bigint = SINGLE_LEG_GAS_UNITS,
): boolean {
  const competitorMax = BigInt(obs.competition?.maxCompetitorPriorityFeeWei || "0");
  if (competitorMax <= 0n) return false;
  if (competitorMax >= KEEPER_SPIKE_THRESHOLD_WEI) return true;
  const ceiling = maxProfitablePriorityFeeWei(
    expectedProfitUsd,
    obs.fairPriceUsdcPerWeth,
    gasUnits,
  );
  return competitorMax > ceiling;
}

/**
 * Dynamic EV-proportional + anti-frontrun priority fee auction bidder (ASCON §3.2).
 *
 * - Scales priority fee based on expected USD profit (`expectedProfitUsd`) and competitor bids (`obs.competition`).
 * - Caps priority fee at 15% (`MAX_PROFIT_SHARE_BPS = 1500`) of expected profit so total gas (base + priority)
 *   stays <= 20% of expected profit.
 * - Anti-Frontrun Filter: If `obs.competition.maxCompetitorPriorityFeeWei` exceeds our EV priority fee ceiling
 *   (meaning a whale/bot like `0x4075...` is bidding 50 gwei and will beat us to `txIndex: 0`), we NEVER bid
 *   15-21 gwei just to land second (`txIndex: 1`)! Instead, we drop priority fee to the minimal floor (`0.05 gwei`).
 */
export function computeEvPriorityFee(
  obs: AgentObservation,
  params: Tuning,
  opts: {
    expectedProfitUsd: number;
    gasUnits?: bigint;
    moduleMult?: number;
  },
): string {
  const minBid = BigInt(obs.limits?.defaultPriorityFeePerGasWei || "0");
  const maxBid = BigInt(obs.limits?.maxPriorityFeePerGasWei || "0");
  const mult = opts.moduleMult ?? params.ammArb.priorityFeeMult;
  const gasUnits = opts.gasUnits ?? SINGLE_LEG_GAS_UNITS;

  const comp = obs.competition;
  const competitorMax = BigInt(comp?.maxCompetitorPriorityFeeWei || "0");
  const revertRate = comp?.recentRevertRate ?? 0;

  // Baseline parity path: when no competitor is bidding above the floor and mult === 1
  if (mult === 1 && competitorMax <= minBid && revertRate <= 0.1) {
    return minBid.toString();
  }

  const baseCeilingPerGas = maxProfitablePriorityFeeWei(
    opts.expectedProfitUsd,
    obs.fairPriceUsdcPerWeth,
    gasUnits,
  );

  // Anti-Frontrun Filter: if rival bid > our max profitable EV ceiling (or is a >= 35 gwei keeper),
  // do NOT waste gas bidding 15-21 gwei to land at txIndex: 1! Drop immediately to the minimal floor (0.05 gwei).
  if (competitorMax > baseCeilingPerGas || competitorMax >= KEEPER_SPIKE_THRESHOLD_WEI) {
    const antiFrontrunFloor =
      minBid > 0n && minBid < MIN_ANTI_FRONTRUN_FLOOR_WEI
        ? minBid
        : MIN_ANTI_FRONTRUN_FLOOR_WEI;
    return antiFrontrunFloor.toString();
  }

  const scaledFloor =
    mult >= 8 ? BigInt(scalePriorityFee(minBid.toString(), mult)) : minBid;
  let targetBid = scaledFloor;

  if (competitorMax > 0n) {
    const marginBps = revertRate > 0.4 ? 6100n : 2100n;
    const propMargin = (competitorMax * marginBps) / 10_000n;
    const minMargin =
      mult >= 3 ? (minBid * 105n) / 100n : 0n;
    const margin = propMargin > minMargin ? propMargin : minMargin;
    const compBid = competitorMax + margin;
    if (compBid > targetBid) targetBid = compBid;
  }

  if (baseCeilingPerGas > minBid) {
    if (mult >= 8 && competitorMax <= minBid) {
      const evBid = minBid + ((baseCeilingPerGas - minBid) * 35n) / 100n;
      if (evBid > targetBid) targetBid = evBid;
    }
    if (targetBid > baseCeilingPerGas) {
      targetBid = baseCeilingPerGas;
    }
  } else {
    targetBid = minBid;
  }

  if (targetBid < minBid) targetBid = minBid;
  if (maxBid > 0n && targetBid > maxBid) targetBid = maxBid;
  return targetBid.toString();
}
