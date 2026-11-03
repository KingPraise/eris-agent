import type { AgentAction, AgentObservation, BundleActionItem } from "@eris/sdk";
import { canFund, sized } from "../../lib/affordable.js";
import { marketViews, type AgentVenue } from "../../lib/markets.js";
import {
  computeEvPriorityFee,
  isRivalAboveEvCeiling,
  passesNetEvGate,
  SINGLE_LEG_GAS_UNITS,
  TWO_LEG_GAS_UNITS,
  scalePriorityFee,
} from "../engine/priorityFee.js";
import { clampSafetyParams, type Tuning } from "../StrategyTuning.js";

export { scalePriorityFee };

export type ModuleCandidate = {
  module: "ammArb" | "pegArb" | "liquidation";
  action: AgentAction;
  expectedEdgeBps: number;
  reason: string;
};

type Venue = {
  swapType: "swap" | "balancerSwap" | "curveSwap";
  price: number;
};

function baseToFloat(amountBaseWei: bigint, decimals: number): number {
  return Number(amountBaseWei) / 10 ** decimals;
}

function floatToBase(amount: number, decimals: number): bigint {
  return BigInt(Math.max(0, Math.floor(amount * 10 ** decimals)));
}

function capAmountByNotionalUsd(
  amountIn: bigint,
  tokenIn: string,
  decimals: number,
  refPriceUsd: number,
  maxNotionalUsd: number,
): bigint {
  if (amountIn <= 0n || maxNotionalUsd <= 0) return amountIn;
  if (tokenIn === "USDC") {
    const capUnits = BigInt(Math.floor(maxNotionalUsd * 1e6));
    return amountIn > capUnits ? capUnits : amountIn;
  }
  if (!Number.isFinite(refPriceUsd) || refPriceUsd <= 0) return amountIn;
  const capBase = floatToBase(maxNotionalUsd / refPriceUsd, decimals);
  return capBase > 0n && amountIn > capBase ? capBase : amountIn;
}

function sizedBaseOrUsdc(
  usdcBal: bigint,
  baseBalanceWei: string,
  baseDecimals: number,
  buyBase: boolean,
  sizeBps: number,
): bigint {
  const cap = buyBase ? usdcBal : BigInt(baseBalanceWei || "0");
  if (cap <= 0n) return 0n;
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(sizeBps))));
  const amt = (cap * bps) / 10_000n;
  const minFloor = buyBase
    ? 1_000_000n
    : baseDecimals === 8
      ? 10_000n // 0.0001 WBTC (8 decimals)
      : 1_000_000_000_000_000n; // 0.001 WETH (18 decimals)
  return amt >= minFloor ? amt : 0n;
}

const TWO_LEG_SAFETY_BPS = 50;

export function evaluateAmmArb(
  obs: AgentObservation,
  rawParams: Tuning,
): { candidate: ModuleCandidate | null; noopReason: string } {
  const params = clampSafetyParams(rawParams);
  const fair = obs.fairPriceUsdcPerWeth;
  if (!Number.isFinite(fair) || fair <= 0) {
    return { candidate: null, noopReason: "no fundable gap worth taking" };
  }

  const usdcBal = BigInt(obs.balances.usdcUnits || "0");
  const views = marketViews(obs);
  const isDefaultParity =
    params.ammArb.minGapBps <= 12 &&
    params.ammArb.sizeBps === 1000 &&
    params.regime === "unknown";
  const isThinBookRegime =
    params.regime === "cdp-incident" ||
    params.regime === "lending-incident" ||
    params.regime === "crash" ||
    params.regime === "spike";
  // With slippageBps clamped <= 50, cap single-swap notional at $7,400 in thinned-book regimes
  // and $16,000 in normal-depth regimes so price impact never exceeds the 50 bps slippage guard
  const maxSwapNotionalUsd = isThinBookRegime ? 7_400 : 16_000;
  const isIncidentAdaptive =
    !isDefaultParity &&
    (params.regime === "cdp-incident" || params.regime === "lending-incident");

  // 1. In cdp-incident and lending-incident, rank all venues by |gap| and size up to 5000 bps (50% of wallet,
  //    bounded by maxSwapNotionalUsd so 50 bps slippage never reverts on thinned books)
  if (isIncidentAdaptive) {
    const gapThreshold = params.ammArb.minGapBps / 10_000;
    const maxSizeCap = Math.max(3500, params.ammArb.sizeBps);
    const ranked = views
      .flatMap((view) =>
        view.venues.map((v) => ({
          base: view.base,
          decimals: view.baseDecimals,
          baseBalanceWei: view.baseBalanceWei,
          fair: view.fair,
          swapType: v.swapType,
          price: v.price,
          feeBps: v.feeBps,
          gap: view.fair / v.price - 1,
        })),
      )
      .filter((c) => Number.isFinite(c.gap) && Math.abs(c.gap) >= gapThreshold)
      .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

    for (const cand of ranked) {
      const edge = Math.abs(cand.gap);
      if (edge <= 0) continue;
      const buyBase = cand.gap > 0;
      const tokenIn = buyBase ? "USDC" : cand.base;
      if (!canFund(obs, tokenIn)) continue;
      const szBps = Math.min(
        maxSizeCap,
        Math.max(250, Math.floor(edge * 250_000)),
      );
      const rawAmountIn = sized(obs, tokenIn, szBps);
      const amountIn = capAmountByNotionalUsd(
        rawAmountIn,
        tokenIn,
        cand.decimals,
        cand.price,
        maxSwapNotionalUsd,
      );
      if (amountIn === 0n) continue;

      const sizeUsd =
        tokenIn === "USDC"
          ? Number(amountIn) / 1e6
          : (Number(amountIn) / 10 ** cand.decimals) * cand.fair;
      const profitUsd = sizeUsd * edge;

      // Anti-frontrun filter: skip thin-edge arbs (< 25 bps edge) when rival bids above our EV ceiling
      if (
        edge * 10_000 < 25 &&
        isRivalAboveEvCeiling(obs, profitUsd, SINGLE_LEG_GAS_UNITS)
      ) {
        continue;
      }

      const fee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd: profitUsd,
        gasUnits: SINGLE_LEG_GAS_UNITS,
        moduleMult: params.ammArb.priorityFeeMult,
      });
      if (!passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) {
        continue;
      }

      const edgeBps = Math.abs(cand.gap) * 10_000;
      const built: AgentAction = {
        type: cand.swapType,
        tokenIn,
        amountIn: amountIn.toString(),
        maxPriorityFeePerGasWei: fee,
        slippageBps: params.ammArb.slippageBps,
        ...(cand.base !== "WETH" ? { base: cand.base } : {}),
      } as AgentAction;

      return {
        candidate: {
          module: "ammArb",
          action: built,
          expectedEdgeBps: edgeBps,
          reason: `ammArb ${cand.base} ${cand.swapType} ${tokenIn} gap=${edgeBps.toFixed(1)}bps`,
        },
        noopReason: "ok",
      };
    }
    return { candidate: null, noopReason: "no fundable gap worth taking" };
  }

  // 2. Check 2-leg delta-neutral cross-venue bundle when spread clears both venue fees + safety margin
  let bestTwo: {
    base: string;
    cheap: AgentVenue;
    rich: AgentVenue;
    netEdgeBps: number;
    usdcIn: bigint;
    baseSell: bigint;
    profitUsd: number;
    isStraddle: boolean;
  } | null = null;

  if (usdcBal >= 1_000_000n) {
    for (const view of views) {
      if (view.venues.length < 2) continue;
      let cheap = view.venues[0]!;
      let rich = view.venues[0]!;
      for (const v of view.venues) {
        if (v.price < cheap.price) cheap = v;
        if (v.price > rich.price) rich = v;
      }
      if (cheap.swapType === rich.swapType || cheap.price <= 0 || rich.price <= 0) {
        continue;
      }
      const spreadBps = (rich.price / cheap.price - 1) * 10_000;
      const roundtripCostBps =
        cheap.feeBps +
        rich.feeBps +
        (params.ammArb.minGapBps >= 40
          ? params.ammArb.minGapBps
          : TWO_LEG_SAFETY_BPS);
      const netEdgeBps = spreadBps - roundtripCostBps;
      if (netEdgeBps <= 0) continue;

      // Scale 2-leg concave size up to 3500 bps (35% of USDC) on wide spreads (`netEdgeBps >= 100`)
      const twoLegCapBps = Math.max(3500, params.ammArb.sizeBps);
      const twoLegSizeBps =
        isDefaultParity && netEdgeBps < 200
          ? 1000
          : Math.min(
              twoLegCapBps,
              Math.max(250, Math.floor((netEdgeBps / 10_000) * 250_000)),
            );
      const rawUsdcIn = (usdcBal * BigInt(twoLegSizeBps)) / 10_000n;
      const usdcIn = capAmountByNotionalUsd(
        rawUsdcIn,
        "USDC",
        6,
        1,
        maxSwapNotionalUsd,
      );
      if (usdcIn < 1_000_000n) continue;
      const boughtBase = baseToFloat(usdcIn, 6) / cheap.price;
      const existingBase = baseToFloat(
        BigInt(view.baseBalanceWei || "0"),
        view.baseDecimals,
      );
      const maxSellBase = maxSwapNotionalUsd / rich.price;
      const freshSell = boughtBase * 0.98;
      const drainBase = !isDefaultParity
        ? Math.min(existingBase, Math.max(0, maxSellBase - freshSell))
        : 0;
      const baseSell = floatToBase(
        isDefaultParity ? boughtBase * 0.98 : drainBase + freshSell,
        view.baseDecimals,
      );
      if (baseSell <= 0n) continue;

      const profitUsd = baseToFloat(usdcIn, 6) * (netEdgeBps / 10_000);
      if (
        netEdgeBps < 25 &&
        isRivalAboveEvCeiling(obs, profitUsd, TWO_LEG_GAS_UNITS)
      ) {
        continue;
      }
      const previewFee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd: profitUsd,
        gasUnits: TWO_LEG_GAS_UNITS,
        moduleMult: params.ammArb.priorityFeeMult,
      });
      if (!passesNetEvGate(profitUsd, previewFee, TWO_LEG_GAS_UNITS, fair)) {
        continue;
      }
      const isStraddle =
        cheap.price < view.fair * 0.996 && rich.price > view.fair * 1.004;
      if (!bestTwo || profitUsd > bestTwo.profitUsd) {
        bestTwo = {
          base: view.base,
          cheap,
          rich,
          netEdgeBps,
          usdcIn,
          baseSell,
          profitUsd,
          isStraddle,
        };
      }
    }
  }

  // 3. Evaluate WETH single-leg vs fair price
  const p = obs.protocols ?? {};
  const wethView = views.find((vw) => vw.base === "WETH");
  const venues: Array<Venue & { feeBps: number }> = [];
  if (params.ammArb.minGapBps >= 40 && wethView && wethView.venues.length > 0) {
    for (const v of wethView.venues) {
      venues.push({ swapType: v.swapType, price: v.price, feeBps: v.feeBps });
    }
  } else {
    if (p.uniswap?.pool) {
      venues.push({
        swapType: "swap",
        price: p.uniswap.pool.priceUsdcPerWeth,
        feeBps: p.uniswap.pool.fee ? p.uniswap.pool.fee / 100 : 30,
      });
    }
    if (p.balancer) {
      venues.push({
        swapType: "balancerSwap",
        price: p.balancer.priceUsdcPerWeth,
        feeBps: (p.balancer as { swapFeeBps?: number }).swapFeeBps ?? 30,
      });
    }
    if (p.curve) {
      venues.push({
        swapType: "curveSwap",
        price: p.curve.priceUsdcPerWeth,
        feeBps: (p.curve as { feeBps?: number }).feeBps ?? 4,
      });
    }
  }

  const isDirectionalRegime =
    params.regime === "cex-drift" ||
    params.regime === "spike" ||
    params.regime === "crash" ||
    params.regime === "cdp-incident" ||
    params.regime === "lending-incident" ||
    (isDefaultParity && (obs.round ?? 0) === 0);

  let best: (Venue & { feeBps: number }) | undefined;
  let bestGap = params.ammArb.minGapBps / 10_000;
  let bestProfitUsd = 0;
  for (const v of venues) {
    if (!Number.isFinite(v.price) || v.price <= 0) continue;
    const gap = Math.abs(fair / v.price - 1);
    const reqGap =
      params.ammArb.minGapBps >= 40
        ? (v.feeBps + params.ammArb.minGapBps) / 10_000
        : isDirectionalRegime
          ? params.ammArb.minGapBps / 10_000
          : Math.max(params.ammArb.minGapBps, v.feeBps + 12) / 10_000;
    const tokenIn = v.price < fair ? "USDC" : "WETH";
    if (gap <= reqGap || !canFund(obs, tokenIn)) {
      continue;
    }
    const netEdgeAfterFee = isDirectionalRegime
      ? gap
      : Math.max(0, gap - v.feeBps / 10_000);
    if (netEdgeAfterFee <= 0) continue;

    if (isDefaultParity && gap < 0.021) {
      const amt = sized(obs, tokenIn, 1000);
      if (amt === 0n) continue;
      const szUsd =
        tokenIn === "USDC" ? Number(amt) / 1e6 : (Number(amt) / 1e18) * fair;
      const prof = szUsd * netEdgeAfterFee;
      const fee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd: prof,
        gasUnits: SINGLE_LEG_GAS_UNITS,
        moduleMult: params.ammArb.priorityFeeMult,
      });
      if (!passesNetEvGate(prof, fee, SINGLE_LEG_GAS_UNITS, fair)) continue;
      if (gap > bestGap) {
        bestGap = gap;
        bestProfitUsd = prof;
        best = v;
      }
    } else {
      const sizingEdge =
        params.ammArb.minGapBps >= 40 ? Math.max(0, gap - reqGap) : netEdgeAfterFee;
      const maxSizeCap = Math.max(3500, params.ammArb.sizeBps);
      const sizeGain =
        params.ammArb.minGapBps >= 40
          ? 220_000
          : params.ammArb.sizeBps >= 2500
            ? 400_000
            : 250_000;
      const szBps = Math.min(maxSizeCap, Math.max(250, Math.floor(sizingEdge * sizeGain)));
      const rawAmt = sized(obs, tokenIn, szBps);
      const amt = capAmountByNotionalUsd(
        rawAmt,
        tokenIn,
        18,
        v.price,
        maxSwapNotionalUsd,
      );
      if (amt === 0n) continue;
      const szUsd =
        tokenIn === "USDC"
          ? Number(amt) / 1e6
          : (Number(amt) / 1e18) * (params.ammArb.minGapBps >= 40 ? v.price : fair);
      const prof =
        params.ammArb.minGapBps >= 40 ? szUsd * sizingEdge : szUsd * netEdgeAfterFee;
      if (
        netEdgeAfterFee * 10_000 < 25 &&
        isRivalAboveEvCeiling(obs, prof, SINGLE_LEG_GAS_UNITS)
      ) {
        continue;
      }
      const fee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd: prof,
        gasUnits: SINGLE_LEG_GAS_UNITS,
        moduleMult: params.ammArb.priorityFeeMult,
      });
      if (!passesNetEvGate(prof, fee, SINGLE_LEG_GAS_UNITS, fair)) {
        continue;
      }
      if (prof > bestProfitUsd) {
        bestProfitUsd = prof;
        bestGap = gap;
        best = v;
      }
    }
  }

  // 4. Multi-base single-leg evaluation (WBTC etc.) — scan all bases across all venues and pick largest net edge
  let bestMulti: {
    base: string;
    decimals: number;
    fair: number;
    venue: AgentVenue;
    gap: number;
    netEdgeBps: number;
    tokenIn: string;
    amountIn: bigint;
    profitUsd: number;
  } | null = null;

  for (const view of views) {
    if (view.base === "WETH") continue;
    for (const v of view.venues) {
      const gap = Math.abs(view.fair / v.price - 1);
      const minBaseGap =
        (v.feeBps + Math.max(50, params.ammArb.minGapBps)) / 10_000;
      if (gap <= minBaseGap) continue;
      const buyBase = v.price < view.fair;
      const tokenIn = buyBase ? "USDC" : view.base;
      const sizingEdge = Math.max(0, gap - minBaseGap);
      const maxMultiCap = Math.max(3500, params.ammArb.sizeBps);
      const sizeBps =
        isDefaultParity && gap < 0.021
          ? 1000
          : Math.min(maxMultiCap, Math.max(250, Math.floor(sizingEdge * 250_000)));
      const rawAmountIn = sizedBaseOrUsdc(
        usdcBal,
        view.baseBalanceWei,
        view.baseDecimals,
        buyBase,
        sizeBps,
      );
      const amountIn = capAmountByNotionalUsd(
        rawAmountIn,
        tokenIn,
        view.baseDecimals,
        v.price,
        maxSwapNotionalUsd,
      );
      if (amountIn === 0n) continue;

      const sizeUsd =
        tokenIn === "USDC"
          ? Number(amountIn) / 1e6
          : (Number(amountIn) / 10 ** view.baseDecimals) *
            (params.ammArb.minGapBps >= 40 ? v.price : view.fair);
      const netEdgeAfterFee = Math.max(0, gap - v.feeBps / 10_000);
      const profitUsd =
        params.ammArb.minGapBps >= 40
          ? sizeUsd * sizingEdge
          : sizeUsd * netEdgeAfterFee;
      if (
        netEdgeAfterFee * 10_000 < 25 &&
        isRivalAboveEvCeiling(obs, profitUsd, SINGLE_LEG_GAS_UNITS)
      ) {
        continue;
      }
      const previewFee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd: profitUsd,
        gasUnits: SINGLE_LEG_GAS_UNITS,
        moduleMult: params.ammArb.priorityFeeMult,
      });
      if (!passesNetEvGate(profitUsd, previewFee, SINGLE_LEG_GAS_UNITS, fair)) {
        continue;
      }
      if (!bestMulti || profitUsd > bestMulti.profitUsd) {
        bestMulti = {
          base: view.base,
          decimals: view.baseDecimals,
          fair: view.fair,
          venue: v,
          gap,
          netEdgeBps: gap * 10_000,
          tokenIn,
          amountIn,
          profitUsd,
        };
      }
    }
  }

  const singleLegEdgeBps = best ? bestGap * 10_000 : 0;

  let wethCandidate: {
    action: AgentAction;
    expectedEdgeBps: number;
    profitUsd: number;
    reason: string;
  } | null = null;

  if (best) {
    const tokenIn = best.price < fair ? "USDC" : "WETH";
    const reqGap =
      params.ammArb.minGapBps >= 40
        ? (best.feeBps + params.ammArb.minGapBps) / 10_000
        : isDirectionalRegime
          ? params.ammArb.minGapBps / 10_000
          : Math.max(params.ammArb.minGapBps, best.feeBps + 12) / 10_000;
    const netEdgeAfterFee = isDirectionalRegime
      ? bestGap
      : Math.max(0, bestGap - best.feeBps / 10_000);
    const sizingEdge =
      params.ammArb.minGapBps >= 40 ? Math.max(0, bestGap - reqGap) : netEdgeAfterFee;
    const maxSizeCap = Math.max(3500, params.ammArb.sizeBps);
    const sizeGain =
      params.ammArb.minGapBps >= 40
        ? 220_000
        : params.ammArb.sizeBps >= 2500
          ? 400_000
          : 250_000;
    const effectiveSizeBps =
      isDefaultParity && bestGap < 0.021
        ? 1000
        : Math.min(maxSizeCap, Math.max(250, Math.floor(sizingEdge * sizeGain)));
    const rawAmountIn = sized(obs, tokenIn, effectiveSizeBps);
    const amountIn =
      isDefaultParity && bestGap < 0.021
        ? rawAmountIn
        : capAmountByNotionalUsd(
            rawAmountIn,
            tokenIn,
            18,
            best.price,
            maxSwapNotionalUsd,
          );
    if (amountIn > 0n) {
      const sizeUsd =
        tokenIn === "USDC"
          ? Number(amountIn) / 1e6
          : (Number(amountIn) / 1e18) *
            (params.ammArb.minGapBps >= 40 ? best.price : fair);
      const netProfitBps =
        params.ammArb.minGapBps >= 40 ? sizingEdge : netEdgeAfterFee;
      const profitUsd = sizeUsd * netProfitBps;
      const fee = computeEvPriorityFee(obs, params, {
        expectedProfitUsd: profitUsd,
        gasUnits: SINGLE_LEG_GAS_UNITS,
        moduleMult: params.ammArb.priorityFeeMult,
      });
      if (passesNetEvGate(profitUsd, fee, SINGLE_LEG_GAS_UNITS, fair)) {
        wethCandidate = {
          action: {
            type: best.swapType,
            tokenIn,
            amountIn: amountIn.toString(),
            maxPriorityFeePerGasWei: fee,
            slippageBps: params.ammArb.slippageBps,
          },
          expectedEdgeBps: singleLegEdgeBps,
          profitUsd,
          reason: `ammArb ${best.swapType} ${tokenIn} gap=${singleLegEdgeBps.toFixed(1)}bps`,
        };
      }
    } else if (isDefaultParity) {
      return { candidate: null, noopReason: "size below the floor" };
    }
  }

  const preferTwoLeg =
    bestTwo !== null &&
    (isDefaultParity
      ? bestTwo.netEdgeBps > singleLegEdgeBps
      : params.ammArb.minGapBps >= 40 || bestTwo.netEdgeBps > singleLegEdgeBps);

  if (bestTwo && preferTwoLeg) {
    const fee = computeEvPriorityFee(obs, params, {
      expectedProfitUsd: bestTwo.profitUsd,
      gasUnits: TWO_LEG_GAS_UNITS,
      moduleMult: params.ammArb.priorityFeeMult,
    });
    const leg1: BundleActionItem = {
      type: bestTwo.cheap.swapType,
      tokenIn: "USDC",
      amountIn: bestTwo.usdcIn.toString(),
      slippageBps: params.ammArb.slippageBps,
      ...(bestTwo.base !== "WETH" ? { base: bestTwo.base } : {}),
    };
    const leg2: BundleActionItem = {
      type: bestTwo.rich.swapType,
      tokenIn: bestTwo.base,
      amountIn: bestTwo.baseSell.toString(),
      slippageBps: params.ammArb.slippageBps,
      ...(bestTwo.base !== "WETH" ? { base: bestTwo.base } : {}),
    };
    return {
      candidate: {
        module: "ammArb",
        action: {
          type: "bundle",
          actions: [leg1, leg2],
          maxPriorityFeePerGasWei: fee,
        },
        expectedEdgeBps: bestTwo.netEdgeBps,
        reason: `ammArb 2-leg ${bestTwo.base} ${bestTwo.cheap.swapType}->${bestTwo.rich.swapType} net=${bestTwo.netEdgeBps.toFixed(1)}bps`,
      },
      noopReason: "ok",
    };
  }

  // In default parity mode, WETH single-leg has priority; in tuned mode, pick whichever base (WETH vs WBTC) has higher expected USD profit!
  if (
    wethCandidate &&
    (isDefaultParity ||
      !bestMulti ||
      wethCandidate.profitUsd >= bestMulti.profitUsd)
  ) {
    return {
      candidate: {
        module: "ammArb",
        action: wethCandidate.action,
        expectedEdgeBps: wethCandidate.expectedEdgeBps,
        reason: wethCandidate.reason,
      },
      noopReason: "ok",
    };
  }

  if (bestMulti) {
    const fee = computeEvPriorityFee(obs, params, {
      expectedProfitUsd: bestMulti.profitUsd,
      gasUnits: SINGLE_LEG_GAS_UNITS,
      moduleMult: params.ammArb.priorityFeeMult,
    });
    return {
      candidate: {
        module: "ammArb",
        action: {
          type: bestMulti.venue.swapType,
          base: bestMulti.base,
          tokenIn: bestMulti.tokenIn,
          amountIn: bestMulti.amountIn.toString(),
          maxPriorityFeePerGasWei: fee,
          slippageBps: params.ammArb.slippageBps,
        },
        expectedEdgeBps: bestMulti.netEdgeBps,
        reason: `ammArb ${bestMulti.base} ${bestMulti.venue.swapType} ${bestMulti.tokenIn} gap=${bestMulti.netEdgeBps.toFixed(1)}bps`,
      },
      noopReason: "ok",
    };
  }

  return { candidate: null, noopReason: "no fundable gap worth taking" };
}
