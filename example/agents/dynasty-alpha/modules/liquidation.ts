import type { AgentAction, AgentObservation } from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";
import { maxUint256 } from "viem";
import { buildLiquidationCall } from "../../lib/aave-liquidation.js";
import {
  computeEvPriorityFee,
  passesNetEvGate,
  SINGLE_LEG_GAS_UNITS,
} from "../engine/priorityFee.js";
import type { Tuning } from "../StrategyTuning.js";
import type { ModuleCandidate } from "./ammArb.js";

const LIQUIDATION_MARGIN = 0.005;
const MIN_CLAIM_USD = 50;
const MIN_EUSD_WEI = 200n * 10n ** 18n;
const MIN_USDC_UNITS = 100n * 10n ** 6n;
const MIN_WETH_FOR_DEBT_SWAP_WEI = 100_000_000_000_000_000n; // 0.1 WETH
const GMX_USD_SCALE = 10n ** 30n;

function richestWethVenue(
  obs: AgentObservation,
): { swapType: "swap" | "balancerSwap" | "curveSwap"; price: number } | null {
  const p = obs.protocols ?? {};
  const venues: Array<{
    swapType: "swap" | "balancerSwap" | "curveSwap";
    price: number;
  }> = [];
  if (p.uniswap?.pool) {
    venues.push({ swapType: "swap", price: p.uniswap.pool.priceUsdcPerWeth });
  }
  if (p.balancer) {
    venues.push({
      swapType: "balancerSwap",
      price: p.balancer.priceUsdcPerWeth,
    });
  }
  if (p.curve) {
    venues.push({
      swapType: "curveSwap",
      price: p.curve.priceUsdcPerWeth,
    });
  }
  let best: (typeof venues)[number] | null = null;
  for (const v of venues) {
    if (!Number.isFinite(v.price) || v.price <= 0) continue;
    if (!best || v.price > best.price) best = v;
  }
  return best;
}

export function evaluateLiquidation(
  obs: AgentObservation,
  params: Tuning,
): ModuleCandidate | null {
  const fair =
    Number.isFinite(obs.fairPriceUsdcPerWeth) && obs.fairPriceUsdcPerWeth > 0
      ? obs.fairPriceUsdcPerWeth
      : 3000;
  const wethWei = BigInt(obs.balances.wethWei || "0");
  const p = obs.protocols ?? {};
  const maxAmmWethPrice = Math.max(
    p.uniswap?.pool?.priceUsdcPerWeth ?? 0,
    p.balancer?.priceUsdcPerWeth ?? 0,
    p.curve?.priceUsdcPerWeth ?? 0,
  );
  // While holding > 0.05 WETH during an active ETH crash (AMM pool price > fair * 1.002),
  // do not pre-empt AMM WETH sells with liquidation or SP actions that acquire or lock ETH exposure!
  const activeWethCrashSell =
    wethWei > 50_000_000_000_000_000n && maxAmmWethPrice > fair * 1.002;

  // 1. Liquity Trove Liquidation (Normal Mode < MCR, or Recovery Mode < TCR when SP covers debt)
  const liquity = obs.protocols?.liquity;
  if (liquity) {
    const riskiest = liquity.riskiestTrove;
    if (riskiest) {
      const underMcr = riskiest.icr < liquity.mcr - LIQUIDATION_MARGIN;
      const entireDebt =
        BigInt(riskiest.netDebtEusdWei || "0") + 200n * 10n ** 18n;
      const underTcrInRecovery =
        liquity.recoveryMode &&
        riskiest.icr < liquity.tcr - LIQUIDATION_MARGIN &&
        entireDebt <= BigInt(liquity.spTotalDepositsEusdWei || "0");

      if ((underMcr || underTcrInRecovery) && !activeWethCrashSell) {
        const debtUsd = Number(riskiest.netDebtEusdWei || "0") / 1e18;
        // Liquity pays 200 eUSD gas compensation + 0.5% collateral bonus + SP share payout
        const expectedProfitUsd = Math.max(200, debtUsd * 0.05);
        const fee = computeEvPriorityFee(obs, params, {
          expectedProfitUsd,
          moduleMult: params.liquidation.priorityFeeMult,
        });
        if (passesNetEvGate(expectedProfitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) {
          return {
            module: "liquidation",
            action: {
              type: "liquityLiquidate",
              borrowers: [riskiest.owner],
              maxPriorityFeePerGasWei: fee,
            },
            expectedEdgeBps: Math.max(params.liquidation.minBonusBps, 500),
            reason: `liquidation liquityLiquidate ${riskiest.owner} (icr=${riskiest.icr.toFixed(3)})`,
          };
        }
      }
    }

    // 2. Claim accrued Stability Pool ETH gain (withdraw 0 eUSD)
    const gainUsd =
      (Number(liquity.spEthGainWei || "0") / 1e18) * liquity.priceUsd;
    if (gainUsd >= MIN_CLAIM_USD) {
      const expectedProfitUsd = Math.max(15, gainUsd * 0.1);
      const fee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd,
        moduleMult: params.liquidation.priorityFeeMult,
      });
      if (passesNetEvGate(expectedProfitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) {
        return {
          module: "liquidation",
          action: {
            type: "liquityWithdrawFromSP",
            amountEusdWei: "0",
            maxPriorityFeePerGasWei: fee,
          },
          expectedEdgeBps: 350,
          reason: `liquidation claim SP ETH gain ($${gainUsd.toFixed(1)})`,
        };
      }
    }

    // 3. Deposit idle eUSD into Stability Pool during cdp-incident (only while an active risky trove exists and after WETH crash sells finish)
    const eusdWei = BigInt(liquity.eusdBalanceWei || "0");
    if (
      params.regime === "cdp-incident" &&
      eusdWei >= MIN_EUSD_WEI &&
      Boolean(liquity.riskiestTrove) &&
      !activeWethCrashSell
    ) {
      const expectedProfitUsd = (Number(eusdWei) / 1e18) * 0.025;
      const fee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd,
        moduleMult: params.liquidation.priorityFeeMult,
      });
      if (passesNetEvGate(expectedProfitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) {
        return {
          module: "liquidation",
          action: {
            type: "liquityProvideToSP",
            amountEusdWei: eusdWei.toString(),
            maxPriorityFeePerGasWei: fee,
          },
          expectedEdgeBps: 250,
          reason: "liquidation provide eUSD to Stability Pool",
        };
      }
    }
  }

  // 4. Aave V3 Liquidation Call when target victim has Health Factor < maxHealthFactor
  const usdcUnits = BigInt(obs.balances.usdcUnits || "0");
  const victimEnv = (process.env.ERIS_LIQUIDATION_VICTIMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const aave = obs.protocols?.aave;
  if (aave && !activeWethCrashSell) {
    const rawHf = aave.healthFactor ?? "";
    const hf = rawHf.includes(".")
      ? Number(rawHf)
      : Number(rawHf) / 1e18;
    const targetVictim = victimEnv[0];
    if (
      targetVictim &&
      Number.isFinite(hf) &&
      hf > 0 &&
      hf < params.liquidation.maxHealthFactor
    ) {
      // Debt-token check: only emit Aave liquidationCall if we hold >= 100 USDC.
      // If we lack the debt token (USDC) but hold WETH, emit a preparatory WETH -> USDC swap first
      // so we never submit a guaranteed-to-revert liquidationCall!
      if (usdcUnits >= MIN_USDC_UNITS) {
        const expectedProfitUsd = Math.max(
          100,
          (Number(usdcUnits) / 1e6) * (params.liquidation.minBonusBps / 10_000),
        );
        const fee = computeEvPriorityFee(obs, params, {
          expectedProfitUsd,
          moduleMult: params.liquidation.priorityFeeMult,
        });
        if (passesNetEvGate(expectedProfitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) {
          const tx = buildLiquidationCall(
            TOKENS.WETH.address,
            TOKENS.USDC.address,
            targetVictim,
            maxUint256,
            false,
          );
          return {
            module: "liquidation",
            action: {
              type: "rawTx",
              tx,
              maxPriorityFeePerGasWei: fee,
            },
            expectedEdgeBps: Math.max(params.liquidation.minBonusBps, 500),
            reason: `liquidation aave liquidationCall ${targetVictim} (hf=${hf.toFixed(3)})`,
          };
        }
      }

      const venue = richestWethVenue(obs);
      if (wethWei >= MIN_WETH_FOR_DEBT_SWAP_WEI && venue) {
        const swapWeth =
          wethWei / 4n >= MIN_WETH_FOR_DEBT_SWAP_WEI
            ? wethWei / 4n
            : MIN_WETH_FOR_DEBT_SWAP_WEI;
        const expectedProfitUsd = (Number(swapWeth) / 1e18) * fair * 0.04;
        const fee = computeEvPriorityFee(obs, params, {
          expectedProfitUsd,
          moduleMult: params.liquidation.priorityFeeMult,
        });
        if (passesNetEvGate(expectedProfitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) {
          const swapAction: AgentAction = {
            type: venue.swapType,
            tokenIn: "WETH",
            amountIn: swapWeth.toString(),
            slippageBps: params.ammArb.slippageBps,
            maxPriorityFeePerGasWei: fee,
          };
          return {
            module: "liquidation",
            action: swapAction,
            expectedEdgeBps: Math.max(params.liquidation.minBonusBps, 450),
            reason: `liquidation acquire USDC debt token via ${venue.swapType} before liquidating ${targetVictim} (hf=${hf.toFixed(3)})`,
          };
        }
      }
    }
  }

  // 5. GMX v2 Margin & Whale/Crash Short-Hedge Management
  const gmx = obs.protocols?.gmx;
  if (gmx) {
    const pos = gmx.position;
    if (pos && BigInt(pos.sizeUsd || "0") > 0n) {
      const collUnits = Number(pos.collateralAmount || "0") / 1e6;
      const marginRatio =
        collUnits > 0 ? (collUnits + pos.pnlUsd) / collUnits : 1;
      const fundingDrag = (pos.fundingOwedUsd ?? 0) > 25;
      // Unwind GMX position if margin falls below safety threshold, funding drag spikes, or regime returns to calm
      if (marginRatio < 0.35 || fundingDrag || params.regime === "calm") {
        const expectedProfitUsd = Math.max(50, collUnits * 0.1);
        const fee = computeEvPriorityFee(obs, params, {
          expectedProfitUsd,
          moduleMult: params.liquidation.priorityFeeMult,
        });
        if (passesNetEvGate(expectedProfitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) {
          return {
            module: "liquidation",
            action: {
              type: "gmxDecrease",
              isLong: pos.isLong,
              collateral: pos.collateral,
              collateralDeltaAmount: pos.collateralAmount,
              sizeDeltaUsd: pos.sizeUsd,
              maxPriorityFeePerGasWei: fee,
            },
            expectedEdgeBps: 400,
            reason: `liquidation unwind GMX position (marginRatio=${marginRatio.toFixed(2)})`,
          };
        }
      }
    } else if (
      params.regime === "crash" &&
      !activeWethCrashSell &&
      wethWei >= 1_000_000_000_000_000_000n &&
      usdcUnits >= 1_500n * 10n ** 6n
    ) {
      const collAmount = usdcUnits / 10n;
      const collUsd = BigInt(Math.floor(Number(collAmount) / 1e6));
      const sizeDeltaUsd = collUsd * 2n * GMX_USD_SCALE;
      const expectedProfitUsd = Number(collUsd) * 0.06;
      const fee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd,
        moduleMult: params.liquidation.priorityFeeMult,
      });
      if (passesNetEvGate(expectedProfitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) {
        return {
          module: "liquidation",
          action: {
            type: "gmxIncrease",
            isLong: false,
            collateral: "USDC",
            collateralAmount: collAmount.toString(),
            sizeDeltaUsd: sizeDeltaUsd.toString(),
            maxPriorityFeePerGasWei: fee,
          },
          expectedEdgeBps: 280,
          reason: "liquidation open defensive GMX short hedge in crash regime",
        };
      }
    }
  }

  return null;
}
