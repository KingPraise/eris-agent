import type { AgentAction, AgentObservation } from "@eris/sdk";
import { decideCarry } from "../../lst-carry/agent.js";
import {
  computeEvPriorityFee,
  passesNetEvGate,
  SINGLE_LEG_GAS_UNITS,
} from "../engine/priorityFee.js";
import type { Tuning } from "../StrategyTuning.js";
import type { ModuleCandidate } from "./ammArb.js";

const REGISTRY_EXIT_BLOCKS = 15;
const REGISTRY_PROBE_BPS = 2000n; // 20% of USDC balance into verified registry lending market
const MIN_USDC_UNITS = 100n * 10n ** 6n; // 100 USDC
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const AvoidedRegistryMarkets = new Set<string>();
const TradedRegistryMarkets = new Set<string>();

export function resetDiscoveryState(): void {
  AvoidedRegistryMarkets.clear();
  TradedRegistryMarkets.clear();
}

/**
 * Evaluates End-of-Epoch Unwind Guard (`blocksRemaining <= 15`).
 *
 * Under ASCON rules (ADR 0022 round-trip rule & issue #27), any registry lending supply or
 * temporary launch/non-core stable balance left open at the final block is either scored at 0
 * or marked at a penalty. This guard runs unconditionally when `blocksRemaining <= 15`.
 */
export function evaluateEndOfEpochUnwind(
  obs: AgentObservation,
  params: Tuning,
): ModuleCandidate | null {
  const remaining = obs.blocksRemaining;
  if (remaining === undefined || remaining > REGISTRY_EXIT_BLOCKS) {
    return null;
  }

  const fee = computeEvPriorityFee(obs, params, {
    expectedProfitUsd: 250,
    moduleMult: Math.max(2, params.ammArb.priorityFeeMult),
  });

  // 1. Unwind any open permissionless lending market supply (`lendingWithdraw` "max")
  const lending = obs.protocols?.lending;
  if (lending?.singleton && Array.isArray(lending.markets)) {
    for (const market of lending.markets) {
      if (BigInt(market.supplyAssets || "0") > 0n) {
        return {
          module: "pegArb",
          action: {
            type: "lendingWithdraw",
            marketId: market.marketId,
            amount: "max",
            maxPriorityFeePerGasWei: fee,
          } as AgentAction,
          expectedEdgeBps: 1000,
          reason: `unwind registry lending market ${market.marketId} before epoch end (${remaining} blocks left)`,
        };
      }
    }
  }

  // 2. Claim any finalized LST withdrawal sitting in the queue before epoch end
  const lst = obs.protocols?.lst;
  if (lst && BigInt(lst.claimableWithdrawalWethWei || "0") > 0n) {
    return {
      module: "pegArb",
      action: {
        type: "lstClaimWithdraw",
        maxPriorityFeePerGasWei: fee,
      },
      expectedEdgeBps: 900,
      reason: `unwind claim finalized LST withdrawal (${remaining} blocks left)`,
    };
  }

  // 3. Unwind any open GMX position before epoch end to avoid funding/mark drag
  const gmxPos = obs.protocols?.gmx?.position;
  if (gmxPos && BigInt(gmxPos.sizeUsd || "0") > 0n) {
    return {
      module: "liquidation",
      action: {
        type: "gmxDecrease",
        isLong: gmxPos.isLong,
        collateral: gmxPos.collateral,
        collateralDeltaAmount: gmxPos.collateralAmount,
        sizeDeltaUsd: gmxPos.sizeUsd,
        maxPriorityFeePerGasWei: fee,
      },
      expectedEdgeBps: 850,
      reason: `unwind open GMX position before epoch end (${remaining} blocks left)`,
    };
  }

  // 4. Unwind any non-USDC market-quoted stable (DAI / EUSD) if near par (discount <= 25 bps)
  const stables = obs.balances?.stables ?? {};
  for (const [symbol, s] of Object.entries(stables)) {
    if (symbol === "USDC" || !s.marketQuoted) continue;
    const balance = BigInt(s.balance || "0");
    const minUnits = 10n * 10n ** BigInt(s.decimals);
    const discountBps = (1 - s.priceUsdc) * 10_000;
    if (balance >= minUnits && discountBps <= 25) {
      if (symbol === "EUSD" && obs.protocols?.liquity) {
        return {
          module: "pegArb",
          action: {
            type: "liquitySwapEusd",
            tokenIn: "EUSD",
            amountIn: balance.toString(),
            slippageBps: params.pegArb.slippageBps,
            maxPriorityFeePerGasWei: fee,
          },
          expectedEdgeBps: 800,
          reason: `unwind EUSD to USDC before epoch end (${remaining} blocks left)`,
        };
      }
      if (symbol !== "EUSD") {
        return {
          module: "pegArb",
          action: {
            type: "stableSwap",
            stable: symbol,
            tokenIn: symbol,
            amountIn: balance.toString(),
            slippageBps: params.pegArb.slippageBps,
            maxPriorityFeePerGasWei: fee,
          },
          expectedEdgeBps: 800,
          reason: `unwind ${symbol} to USDC before epoch end (${remaining} blocks left)`,
        };
      }
    }
  }

  return null;
}

/**
 * Evaluates LST Secondary Market Arbitrage & Carry (`obs.protocols.lst`).
 */
export function evaluateLstArb(
  obs: AgentObservation,
  params: Tuning,
): ModuleCandidate | null {
  const lst = obs.protocols?.lst;
  if (!lst) return null;

  const wethBalanceWei = BigInt(obs.balances.wethWei || "0");
  const fair =
    Number.isFinite(obs.fairPriceUsdcPerWeth) && obs.fairPriceUsdcPerWeth > 0
      ? obs.fairPriceUsdcPerWeth
      : 3000;

  const decision = decideCarry({
    lst,
    wethBalanceWei,
    maxStakeWei: wethBalanceWei,
    maxSwapWei: wethBalanceWei,
    blocksRemaining: obs.blocksRemaining,
  });

  switch (decision.kind) {
    case "claim": {
      const claimWeth = Number(lst.claimableWithdrawalWethWei || "0") / 1e18;
      const profitUsd = Math.max(25, claimWeth * fair * 0.01);
      const fee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd: profitUsd,
        moduleMult: params.ammArb.priorityFeeMult,
      });
      if (!passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) return null;
      return {
        module: "pegArb",
        action: {
          type: "lstClaimWithdraw",
          maxPriorityFeePerGasWei: fee,
        },
        expectedEdgeBps: 300,
        reason: "lstArb claim finalized LST withdrawal",
      };
    }
    case "queue": {
      const wethVal = (Number(decision.lstIn) / 1e18) * fair;
      const profitUsd = wethVal * Math.max(0.003, lst.discountBps / 10_000);
      const fee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd: profitUsd,
        moduleMult: params.ammArb.priorityFeeMult,
      });
      if (!passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) return null;
      return {
        module: "pegArb",
        action: {
          type: "lstRequestWithdraw",
          amountLstWei: decision.lstIn.toString(),
          maxPriorityFeePerGasWei: fee,
        },
        expectedEdgeBps: Math.max(40, lst.discountBps - 12),
        reason: `lstArb queue redemption for discounted LST (${lst.discountBps.toFixed(1)}bps)`,
      };
    }
    case "carry": {
      const wethVal = (Number(decision.wethIn) / 1e18) * fair;
      const edgeBps = Math.max(25, lst.discountBps - 27);
      const profitUsd = wethVal * (edgeBps / 10_000);
      const fee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd: profitUsd,
        moduleMult: params.ammArb.priorityFeeMult,
      });
      if (!passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) return null;
      return {
        module: "pegArb",
        action: {
          type: "lstSwap",
          tokenIn: "WETH",
          amountIn: decision.wethIn.toString(),
          slippageBps: params.pegArb.slippageBps,
          maxPriorityFeePerGasWei: fee,
        },
        expectedEdgeBps: edgeBps,
        reason: `lstArb buy discounted LST (${lst.discountBps.toFixed(1)}bps below redemption)`,
      };
    }
    case "harvest": {
      const lstVal = (Number(decision.lstIn) / 1e18) * fair;
      const premBps = Math.max(25, -lst.discountBps - 27);
      const profitUsd = lstVal * (premBps / 10_000);
      const fee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd: profitUsd,
        moduleMult: params.ammArb.priorityFeeMult,
      });
      if (!passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) return null;
      return {
        module: "pegArb",
        action: {
          type: "lstSwap",
          tokenIn: "LST",
          amountIn: decision.lstIn.toString(),
          slippageBps: params.pegArb.slippageBps,
          maxPriorityFeePerGasWei: fee,
        },
        expectedEdgeBps: premBps,
        reason: `lstArb harvest LST premium (${(-lst.discountBps).toFixed(1)}bps above redemption)`,
      };
    }
    case "stake": {
      if (params.regime !== "calm" && params.regime !== "depeg-persist") {
        return null;
      }
      const remaining = obs.blocksRemaining ?? 360;
      const expectedYieldBps = lst.yieldPerBlockBps * Math.min(remaining, 180);
      if (expectedYieldBps < 20) return null;
      const wethVal = (Number(decision.wethIn) / 1e18) * fair;
      const profitUsd = wethVal * (expectedYieldBps / 10_000);
      const fee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd: profitUsd,
        moduleMult: 1,
      });
      if (!passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) return null;
      return {
        module: "pegArb",
        action: {
          type: "lstDeposit",
          amountWethWei: decision.wethIn.toString(),
          maxPriorityFeePerGasWei: fee,
        },
        expectedEdgeBps: Math.min(22, expectedYieldBps),
        reason: `lstArb stake WETH for yield (${lst.apyBps.toFixed(0)}bps APY)`,
      };
    }
    default:
      return null;
  }
}

/**
 * Evaluates Verified MarketRegistry Lending Opportunities (`obs.registry` + `obs.protocols.lending`).
 */
export function evaluateVerifiedRegistryArb(
  obs: AgentObservation,
  params: Tuning,
): ModuleCandidate | null {
  const remaining = obs.blocksRemaining ?? 360;
  if (remaining <= REGISTRY_EXIT_BLOCKS + 5) return null;

  const lending = obs.protocols?.lending;
  const entries = obs.registry?.entries;
  if (!lending?.singleton || !Array.isArray(lending.markets) || !Array.isArray(entries)) {
    return null;
  }

  const usdcUnits = BigInt(obs.balances.usdcUnits || "0");
  if (usdcUnits < MIN_USDC_UNITS) return null;
  const fair =
    Number.isFinite(obs.fairPriceUsdcPerWeth) && obs.fairPriceUsdcPerWeth > 0
      ? obs.fairPriceUsdcPerWeth
      : 3000;

  const entryById = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    if (e.kind === "lendingMarket" && e.extra) {
      entryById.set(String(e.extra).toLowerCase(), e);
    }
  }

  for (const market of lending.markets) {
    const key = market.marketId.toLowerCase();
    if (AvoidedRegistryMarkets.has(key) || TradedRegistryMarkets.has(key)) {
      continue;
    }
    if (BigInt(market.supplyAssets || "0") > 0n) {
      TradedRegistryMarkets.add(key);
      continue;
    }
    const entry = entryById.get(key);
    if (!entry || entry.mine) continue;

    const codeUnchanged =
      entry.codehashNow === undefined ||
      entry.codehashNow.toLowerCase() === entry.codehashAtRegistration.toLowerCase();
    const zeroOracleOwner =
      entry.oracleOwner !== undefined &&
      entry.oracleOwner.toLowerCase() === ZERO_ADDRESS;

    if (!entry.verified || !codeUnchanged || !zeroOracleOwner) {
      AvoidedRegistryMarkets.add(key);
      continue;
    }

    const amount = (usdcUnits * REGISTRY_PROBE_BPS) / 10_000n;
    if (amount < MIN_USDC_UNITS) continue;

    const profitUsd = Math.max(8, (Number(amount) / 1e6) * 0.008);
    const fee = computeEvPriorityFee(obs, params, {
      expectedProfitUsd: profitUsd,
      moduleMult: params.ammArb.priorityFeeMult,
    });
    if (!passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) continue;

    TradedRegistryMarkets.add(key);
    return {
      module: "pegArb",
      action: {
        type: "lendingSupply",
        marketId: market.marketId,
        amount: amount.toString(),
        maxPriorityFeePerGasWei: fee,
      } as AgentAction,
      expectedEdgeBps: 55,
      reason: `verified registry lendingSupply market=${market.marketId} (codehash & zero oracleOwner verified)`,
    };
  }

  return null;
}
