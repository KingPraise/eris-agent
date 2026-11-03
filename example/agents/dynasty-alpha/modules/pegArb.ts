import type { AgentObservation } from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";
import { decideRedemption } from "../../redemption-arb/agent.js";
import {
  computeEvPriorityFee,
  passesNetEvGate,
  SINGLE_LEG_GAS_UNITS,
} from "../engine/priorityFee.js";
import type { Tuning } from "../StrategyTuning.js";
import type { ModuleCandidate } from "./ammArb.js";
import {
  evaluateLstArb,
  evaluateVerifiedRegistryArb,
  resetDiscoveryState,
} from "./lstAndDiscovery.js";

const MIN_DOLLARS = 10n;
const MIN_USDC_UNITS = 200n * 10n ** 6n;
const SELL_BPS = 10;

let baselineEthWei: bigint | null = null;
let pendingRedeemedWethWei = 0n;

export function resetPegBaselines(): void {
  baselineEthWei = null;
  pendingRedeemedWethWei = 0n;
  resetDiscoveryState();
}

export function evaluatePegArb(
  obs: AgentObservation,
  params: Tuning,
): ModuleCandidate | null {
  const ethWei = BigInt(obs.balances.ethWei || "0");
  const wethWei = BigInt(obs.balances.wethWei || "0");
  const usdcUnits = BigInt(obs.balances.usdcUnits || "0");
  const fair =
    Number.isFinite(obs.fairPriceUsdcPerWeth) && obs.fairPriceUsdcPerWeth > 0
      ? obs.fairPriceUsdcPerWeth
      : 3000;
  if (baselineEthWei === null) baselineEthWei = ethWei;
  if (wethWei < pendingRedeemedWethWei) pendingRedeemedWethWei = wethWei;

  // 1. Liquity eUSD Redemption Arbitrage Loop (buy discounted eUSD -> redeem for ETH -> wrap -> unwind)
  const liquity = obs.protocols?.liquity;
  if (liquity) {
    const canSellEth = Array.isArray(obs.enabledProtocols)
      ? obs.enabledProtocols.includes("uniswap")
      : Boolean(obs.protocols?.uniswap?.pool);

    // Set wethBaselineWei so ONLY wrapped redemption ETH (pendingRedeemedWethWei) is considered sellable by pegArb!
    const wethBaselineWei =
      wethWei > pendingRedeemedWethWei ? wethWei - pendingRedeemedWethWei : 0n;

    const decision = decideRedemption({
      liquity,
      usdcUnits,
      wethWei,
      ethWei,
      ethBaselineWei: baselineEthWei,
      wethBaselineWei,
      canSellEth,
    });

    switch (decision.kind) {
      case "unwind": {
        const profitUsd = Math.max(
          15,
          (Number(decision.wethWei) / 1e18) * fair * 0.015,
        );
        const fee = computeEvPriorityFee(obs, params, {
          expectedProfitUsd: profitUsd,
          moduleMult: params.ammArb.priorityFeeMult,
        });
        if (!passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) break;
        pendingRedeemedWethWei =
          pendingRedeemedWethWei > decision.wethWei
            ? pendingRedeemedWethWei - decision.wethWei
            : 0n;
        return {
          module: "pegArb",
          action: {
            type: "swap",
            tokenIn: "WETH",
            amountIn: decision.wethWei.toString(),
            slippageBps: params.pegArb.slippageBps,
            maxPriorityFeePerGasWei: fee,
          },
          expectedEdgeBps: 150,
          reason: "pegArb unwind redeemed WETH to USDC",
        };
      }
      case "wrap": {
        const profitUsd = Math.max(
          15,
          (Number(decision.ethWei) / 1e18) * fair * 0.014,
        );
        const fee = computeEvPriorityFee(obs, params, {
          expectedProfitUsd: profitUsd,
          moduleMult: params.ammArb.priorityFeeMult,
        });
        if (!passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) break;
        pendingRedeemedWethWei += decision.ethWei;
        return {
          module: "pegArb",
          action: {
            type: "rawTx",
            tx: {
              to: TOKENS.WETH.address,
              data: "0xd0e30db0", // WETH9.deposit()
              value: decision.ethWei.toString(),
            },
            maxPriorityFeePerGasWei: fee,
          },
          expectedEdgeBps: 140,
          reason: "pegArb wrap redeemed ETH to WETH",
        };
      }
      case "sell": {
        const edgeBps = Math.max(25, decision.premiumBps);
        const profitUsd = (Number(decision.eusdIn) / 1e18) * (edgeBps / 10_000);
        const fee = computeEvPriorityFee(obs, params, {
          expectedProfitUsd: profitUsd,
          moduleMult: params.ammArb.priorityFeeMult,
        });
        if (!passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) break;
        return {
          module: "pegArb",
          action: {
            type: "liquitySwapEusd",
            tokenIn: "EUSD",
            amountIn: decision.eusdIn.toString(),
            slippageBps: params.pegArb.slippageBps,
            maxPriorityFeePerGasWei: fee,
          },
          expectedEdgeBps: edgeBps,
          reason: `pegArb sell eUSD above par (+${decision.premiumBps.toFixed(1)}bps)`,
        };
      }
      case "redeem":
        if (liquity.redemptionRateBps <= params.pegArb.maxRedemptionFeeBps) {
          const edgeBps = Math.max(25, decision.edgeBps);
          const profitUsd = (Number(decision.eusdIn) / 1e18) * (edgeBps / 10_000);
          const fee = computeEvPriorityFee(obs, params, {
            expectedProfitUsd: profitUsd,
            moduleMult: params.ammArb.priorityFeeMult,
          });
          if (!passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) break;
          return {
            module: "pegArb",
            action: {
              type: "liquityRedeem",
              amountEusdWei: decision.eusdIn.toString(),
              maxFeeBps: Math.round(params.pegArb.maxRedemptionFeeBps),
              maxPriorityFeePerGasWei: fee,
            },
            expectedEdgeBps: edgeBps,
            reason: `pegArb redeem eUSD edge=${decision.edgeBps.toFixed(1)}bps`,
          };
        }
        break;
      case "buy":
        if (
          liquity.discountBps >= params.pegArb.minDiscountBps &&
          liquity.redemptionRateBps <= params.pegArb.maxRedemptionFeeBps
        ) {
          if (params.regime === "cdp-incident") {
            break;
          }
          // Scale eUSD redemption size up on deep discounts (>= 120 bps)
          const effectivePegBps = Math.max(
            params.pegArb.sizeBps,
            liquity.discountBps >= 120
              ? Math.min(3500, Math.floor(liquity.discountBps * 14))
              : params.pegArb.sizeBps,
          );
          const desiredUsdc = (usdcUnits * BigInt(effectivePegBps)) / 10_000n;
          const cappedUsdc =
            desiredUsdc < decision.usdcIn ? desiredUsdc : decision.usdcIn;
          if (cappedUsdc >= MIN_USDC_UNITS) {
            const profitUsd =
              (Number(cappedUsdc) / 1e6) * (decision.edgeBps / 10_000);
            const fee = computeEvPriorityFee(obs, params, {
              expectedProfitUsd: profitUsd,
              moduleMult: params.ammArb.priorityFeeMult,
            });
            if (!passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) break;
            return {
              module: "pegArb",
              action: {
                type: "liquitySwapEusd",
                tokenIn: "USDC",
                amountIn: cappedUsdc.toString(),
                slippageBps: params.pegArb.slippageBps,
                maxPriorityFeePerGasWei: fee,
              },
              expectedEdgeBps: decision.edgeBps,
              reason: `pegArb buy discounted eUSD (${liquity.discountBps.toFixed(1)}bps off par, edge=${decision.edgeBps.toFixed(1)}bps)`,
            };
          }
        }
        break;
      case "hold":
        break;
    }
  }

  // 2. Curve StableSwap Peg Arbitrage on Market-Quoted Stables (e.g. DAI)
  const stables = obs.balances.stables ?? {};
  for (const [symbol, s] of Object.entries(stables)) {
    if (symbol === "USDC" || symbol === "EUSD" || !s.marketQuoted) continue;
    const balance = BigInt(s.balance || "0");
    const discountBps = (1 - s.priceUsdc) * 10_000;
    const minHolding = MIN_DOLLARS * 10n ** BigInt(s.decimals);

    // Unwind first if peg recovered near/above par
    if (balance >= minHolding && discountBps <= SELL_BPS) {
      const edgeBps = Math.max(30, -discountBps + 25);
      const profitUsd = Math.max(
        10,
        (Number(balance) / 10 ** s.decimals) * (edgeBps / 10_000),
      );
      const fee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd: profitUsd,
        moduleMult: params.ammArb.priorityFeeMult,
      });
      if (passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) {
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
          expectedEdgeBps: edgeBps,
          reason: `pegArb unwind ${symbol} near par (discount=${discountBps.toFixed(1)}bps)`,
        };
      }
    }

    // Buy depegged stable only when not in persistent depeg regime
    if (
      params.regime !== "depeg-persist" &&
      discountBps >= params.pegArb.minDiscountBps &&
      usdcUnits >= MIN_USDC_UNITS
    ) {
      const effectiveStableBps = Math.max(
        params.pegArb.sizeBps,
        discountBps >= 120
          ? Math.min(3500, Math.floor(discountBps * 14))
          : params.pegArb.sizeBps,
      );
      const buyUsdc = (usdcUnits * BigInt(effectiveStableBps)) / 10_000n;
      if (buyUsdc >= MIN_USDC_UNITS) {
        const edgeBps = discountBps - 20;
        const profitUsd = (Number(buyUsdc) / 1e6) * (edgeBps / 10_000);
        const fee = computeEvPriorityFee(obs, params, {
          expectedProfitUsd: profitUsd,
          moduleMult: params.ammArb.priorityFeeMult,
        });
        if (passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) {
          return {
            module: "pegArb",
            action: {
              type: "stableSwap",
              stable: symbol,
              tokenIn: "USDC",
              amountIn: buyUsdc.toString(),
              slippageBps: params.pegArb.slippageBps,
              maxPriorityFeePerGasWei: fee,
            },
            expectedEdgeBps: edgeBps,
            reason: `pegArb buy discounted ${symbol} (${discountBps.toFixed(1)}bps off par)`,
          };
        }
      }
    }
  }

  // 3. LST Secondary Market Arbitrage & Carry (lstClaimWithdraw / lstRequestWithdraw / lstSwap / lstDeposit)
  const lstCand = evaluateLstArb(obs, params);
  if (lstCand) return lstCand;

  // 4. Verified MarketRegistry Lending Supply (strictly verified codehash & zero oracleOwner)
  const regCand = evaluateVerifiedRegistryArb(obs, params);
  if (regCand) return regCand;

  return null;
}
