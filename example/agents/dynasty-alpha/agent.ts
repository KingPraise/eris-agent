import type { AgentAction, AgentObservation } from "@eris/sdk";
import { Engine, type EngineContext } from "./engine/Engine.js";

const engine = new Engine();
const g = globalThis as Record<string, unknown>;
g.__DYNASTY_ENGINE_STEP__ = (
  obs: AgentObservation,
  ctx?: EngineContext,
): AgentAction => engine.step(obs, ctx);

export function extractExecutorBody(agentTsSource: string): string {
  const beginMarker = ["// ===", "BEGIN_EXECUTOR_BODY", "==="].join(" ");
  const endMarker = ["// ===", "END_EXECUTOR_BODY", "==="].join(" ");
  const start = agentTsSource.indexOf(beginMarker);
  const end = agentTsSource.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("executor body markers not found in agent.ts");
  }
  return agentTsSource.slice(start + beginMarker.length, end).trim();
}

export function decide(
  obs: AgentObservation,
  ctx?: EngineContext,
): AgentAction {
  // === BEGIN_EXECUTOR_BODY ===
  const PARAMS = {
    schemaVersion: 1,
    regime: "unknown",
    weights: { ammArb: 1, pegArb: 0, liquidation: 0 },
    ammArb: { minGapBps: 12, sizeBps: 1000, slippageBps: 50, priorityFeeMult: 1 },
    pegArb: { minDiscountBps: 85, sizeBps: 500, slippageBps: 50, maxRedemptionFeeBps: 150 },
    liquidation: { maxHealthFactor: 0.995, minBonusBps: 300, priorityFeeMult: 5 },
    breaker: { maxGasToProfitRatio: 0.35, maxRevertRate: 0.35, cooldownBlocks: 12 },
  };

  const clampSafetyParams = (p = PARAMS) => ({
    ...p,
    ammArb: {
      ...p.ammArb,
      minGapBps: Math.max(Number(p.ammArb.minGapBps || 12), 12),
      slippageBps: Math.min(Number(p.ammArb.slippageBps || 50), 50),
    },
    breaker: {
      ...p.breaker,
      maxGasToProfitRatio: Math.min(Number(p.breaker.maxGasToProfitRatio || 0.35), 0.35),
      maxRevertRate: Math.min(Number(p.breaker.maxRevertRate || 0.35), 0.35),
    },
  });

  const gObj = typeof globalThis !== "undefined" ? Reflect.get(globalThis, "__DYNASTY_ENGINE_STEP__") : null;
  if (typeof gObj === "function") {
    return gObj(obs, ctx);
  }

  // Self-contained VM execution path (100% logic parity with Engine.step() inside node:vm compileExecutor at block 60+)
  try {
    if (!obs || typeof obs !== "object" || !obs.balances || !obs.limits) {
      return { type: "noop", reason: "malformed observation" };
    }

    const rawActiveParams =
      (ctx &&
        typeof ctx === "object" &&
        (Reflect.get(ctx, "__dynastyParams") ||
          (ctx.config && typeof ctx.config === "object" && Reflect.get(ctx.config, "__dynastyParams")))) ||
      PARAMS;
    const activeParams = clampSafetyParams(rawActiveParams);
    let vmState = Reflect.get(Object, "__DYNASTY_VM_STATE__");
    if (!vmState || (typeof obs.round === "number" && obs.round <= 1)) {
      vmState = {
        trippedUntilBlock: -1,
        lastTrippedSampleRound: -1,
        prevEthWei: null,
        prevTotalEth: null,
        prevWbtc: null,
        prevValUsdc: null,
        prevFairWeth: null,
        prevFairWbtc: null,
        cumGasUsd: 0,
        cumProfitUsd: 0,
        pegBaseEthWei: null,
        pendingRedeemedWethWei: 0n,
        avoidedReg: new Set(),
        tradedReg: new Set(),
      };
      Reflect.set(Object, "__DYNASTY_VM_STATE__", vmState);
    }

    const ONE_GWEI = 1000000000n;
    const SINGLE_GAS = 180000n;
    const TWO_GAS = 360000n;
    const BASE_FEE_WEI = 100000000n;
    const MIN_ANTI_FRONTRUN_FLOOR_WEI = 50000000n;
    const MIN_NET_PROFIT_USD = 3.0;
    const MAX_GAS_SHARE = 0.2;
    const MAX_PROFIT_SHARE_BPS = 1950n;
    const KEEPER_SPIKE_WEI = 35000000000n;
    const WETH_ADDR = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
    const USDC_ADDR = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    const AAVE_POOL_ADDR = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
    const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

    const scalePriorityFee = (defaultFeeWei = "0", mult = 1) => {
      const base = BigInt(defaultFeeWei || "0");
      if (mult === 1) return base.toString();
      const scaledBps = BigInt(Math.max(100, Math.round(mult * 100)));
      return ((base * scaledBps) / 100n).toString();
    };

    const maxProfitablePriorityFeeWei = (expectedProfitUsd = 0, fairPrice = 3000, gasUnits = SINGLE_GAS) => {
      if (gasUnits <= 0n || !Number.isFinite(expectedProfitUsd) || expectedProfitUsd <= 0) return 0n;
      const f = Number.isFinite(fairPrice) && fairPrice > 0 ? fairPrice : 3000;
      const profitWei = BigInt(Math.max(0, Math.floor((expectedProfitUsd / f) * 1e9))) * ONE_GWEI;
      const totalCeil = (profitWei * MAX_PROFIT_SHARE_BPS) / 10000n / gasUnits;
      return totalCeil > BASE_FEE_WEI ? totalCeil - BASE_FEE_WEI : 0n;
    };

    const isRivalAboveEvCeiling = (expectedProfitUsd = 0, gasUnits = SINGLE_GAS) => {
      const compMax = BigInt((obs.competition && obs.competition.maxCompetitorPriorityFeeWei) || "0");
      if (compMax <= 0n) return false;
      if (compMax >= KEEPER_SPIKE_WEI) return true;
      const ceil = maxProfitablePriorityFeeWei(expectedProfitUsd, obs.fairPriceUsdcPerWeth, gasUnits);
      return compMax > ceil;
    };

    const passesNetEvGate = (expectedProfitUsd = 0, priorityFeeWei = "0", gasUnits = SINGLE_GAS, fairPrice = 3000) => {
      if (!Number.isFinite(expectedProfitUsd) || expectedProfitUsd < MIN_NET_PROFIT_USD) return false;
      const f = Number.isFinite(fairPrice) && fairPrice > 0 ? fairPrice : 3000;
      const prio = typeof priorityFeeWei === "bigint" ? priorityFeeWei : BigInt(priorityFeeWei || "0");
      const totalGasWei = (BASE_FEE_WEI + prio) * gasUnits;
      const estGasUsd = (Number(totalGasWei) / 1e18) * f;
      return expectedProfitUsd - estGasUsd >= MIN_NET_PROFIT_USD && estGasUsd <= expectedProfitUsd * MAX_GAS_SHARE;
    };

    const computeBid = (expectedProfitUsd = 0, gasUnits = SINGLE_GAS, moduleMult = -1) => {
      const minBid = BigInt(obs.limits.defaultPriorityFeePerGasWei || "0");
      const maxBid = BigInt(obs.limits.maxPriorityFeePerGasWei || "0");
      const mult = moduleMult >= 0 ? moduleMult : activeParams.ammArb.priorityFeeMult;
      const comp = obs.competition;
      const competitorMax = BigInt((comp && comp.maxCompetitorPriorityFeeWei) || "0");
      const revertRate = (comp && comp.recentRevertRate) || 0;
      if (mult === 1 && competitorMax <= minBid && revertRate <= 0.1) {
        return minBid.toString();
      }
      const baseCeilingPerGas = maxProfitablePriorityFeeWei(expectedProfitUsd, obs.fairPriceUsdcPerWeth, gasUnits);
      if (competitorMax > baseCeilingPerGas || competitorMax >= KEEPER_SPIKE_WEI) {
        const floor = minBid > 0n && minBid < MIN_ANTI_FRONTRUN_FLOOR_WEI ? minBid : MIN_ANTI_FRONTRUN_FLOOR_WEI;
        return floor.toString();
      }
      const scaledFloor = mult >= 8 ? BigInt(scalePriorityFee(minBid.toString(), mult)) : minBid;
      let targetBid = scaledFloor;

      if (competitorMax > 0n) {
        const marginBps = revertRate > 0.4 ? 6100n : 2100n;
        const propMargin = (competitorMax * marginBps) / 10000n;
        const minMargin = mult >= 3 ? (minBid * 105n) / 100n : 0n;
        const margin = propMargin > minMargin ? propMargin : minMargin;
        const compBid = competitorMax + margin;
        if (compBid > targetBid) targetBid = compBid;
      }

      if (baseCeilingPerGas > minBid) {
        if (mult >= 8 && competitorMax <= minBid) {
          const evBid = minBid + ((baseCeilingPerGas - minBid) * 35n) / 100n;
          if (evBid > targetBid) targetBid = evBid;
        }
        if (targetBid > baseCeilingPerGas) targetBid = baseCeilingPerGas;
      } else {
        targetBid = minBid;
      }
      if (targetBid < minBid) targetBid = minBid;
      if (maxBid > 0n && targetBid > maxBid) targetBid = maxBid;
      return targetBid.toString();
    };

    const capAmountByNotionalUsd = (amountIn = 0n, tokenIn = "USDC", decimals = 18, refPriceUsd = 3000, maxNotionalUsd = 16000) => {
      if (amountIn <= 0n || maxNotionalUsd <= 0) return amountIn;
      if (tokenIn === "USDC") {
        const capUnits = BigInt(Math.floor(maxNotionalUsd * 1e6));
        return amountIn > capUnits ? capUnits : amountIn;
      }
      if (!Number.isFinite(refPriceUsd) || refPriceUsd <= 0) return amountIn;
      const capBase = BigInt(Math.max(0, Math.floor((maxNotionalUsd / refPriceUsd) * 10 ** decimals)));
      return capBase > 0n && amountIn > capBase ? capBase : amountIn;
    };

    const buildMarketViews = () => {
      const fairByBase = obs.fairPricesUsd || { WETH: obs.fairPriceUsdcPerWeth };
      const bases = Object.keys(fairByBase).sort((a, b) => (a === "WETH" ? -1 : b === "WETH" ? 1 : a < b ? -1 : 1));
      const p = obs.protocols || {};
      const out = [];
      for (const base of bases) {
        const f = fairByBase[base];
        if (!(f > 0)) continue;
        const vList = [];
        for (const proto of ["uniswap", "balancer", "curve"]) {
          let q = null;
          if (proto === "uniswap") {
            const pool = base === "WETH" ? p.uniswap && p.uniswap.pool : p.uniswap && p.uniswap.markets && p.uniswap.markets[`${base}/USDC`];
            if (pool) q = { price: pool.priceUsdcPerWeth, fee: pool.fee };
          } else {
            const amm = proto === "balancer" ? p.balancer : p.curve;
            const slice = base === "WETH" ? amm : amm && amm.markets && amm.markets[`${base}/USDC`];
            if (slice) {
              q = {
                price: slice.priceUsdcPerWeth,
                sellPrice: slice.sellPriceUsdcPerWeth,
                buyPrice: slice.buyPriceUsdcPerWeth,
                effectiveHalfSpreadBps: slice.effectiveHalfSpreadBps,
              };
            }
          }
          if (!q || !(q.price > 0)) continue;
          const twoSided = proto !== "uniswap" && typeof q.effectiveHalfSpreadBps === "number" && q.effectiveHalfSpreadBps >= 0 && typeof q.sellPrice === "number" && typeof q.buyPrice === "number";
          const feeBps = Number(twoSided ? q.effectiveHalfSpreadBps : proto === "uniswap" ? (typeof q.fee === "number" && q.fee > 0 ? q.fee / 100 : 30) : 30);
          const mid = proto === "uniswap" || twoSided ? q.price : q.price / (1 - feeBps / 10000);
          const swapType = proto === "uniswap" ? "swap" : proto === "balancer" ? "balancerSwap" : "curveSwap";
          vList.push({ protocol: proto, swapType, price: mid, feeBps });
        }
        if (vList.length === 0) continue;
        const baseBalanceWei = base === "WETH" ? obs.balances.wethWei : (obs.baseBalances && obs.baseBalances[base]) || "0";
        const baseDecimals = (obs.baseDecimals && obs.baseDecimals[base]) || 18;
        out.push({ base, fair: f, venues: vList, baseBalanceWei, baseDecimals });
      }
      return out;
    };

    const balanceOfToken = (tokenIn = "USDC") => {
      if (tokenIn === "USDC") return BigInt(obs.balances.usdcUnits || "0");
      if (tokenIn === "WETH") return BigInt(obs.balances.wethWei || "0");
      return BigInt((obs.baseBalances && obs.baseBalances[tokenIn]) || "0");
    };
    const minForToken = (tokenIn = "USDC") => (tokenIn === "USDC" ? 1000000n : 1000000000000000n);
    const canFund = (tokenIn = "USDC") => balanceOfToken(tokenIn) >= minForToken(tokenIn);
    const sized = (tokenIn = "USDC", sizeBps = 1000) => {
      const bal = balanceOfToken(tokenIn);
      const amt = (bal * BigInt(Math.max(0, Math.round(sizeBps)))) / 10000n;
      return amt >= minForToken(tokenIn) ? amt : 0n;
    };
    const sizedBaseOrUsdc = (usdcBal = 0n, baseBalanceWei = "0", baseDecimals = 18, buyBase = true, sizeBps = 1000) => {
      const bal = buyBase ? usdcBal : BigInt(baseBalanceWei || "0");
      const minFloor = buyBase ? 1000000n : baseDecimals <= 8 ? 10000n : 1000000000000000n;
      const amt = (bal * BigInt(Math.max(0, Math.round(sizeBps)))) / 10000n;
      return amt >= minFloor ? amt : 0n;
    };

    // 0. End-of-Epoch Unwind Guard (blocksRemaining <= 15)
    const rem = obs.blocksRemaining;
    if (rem !== undefined && rem <= 15) {
      const unwindFee = computeBid(250, SINGLE_GAS, Math.max(2, activeParams.ammArb.priorityFeeMult));
      const lending = obs.protocols && obs.protocols.lending;
      if (lending && lending.singleton && Array.isArray(lending.markets)) {
        for (const m of lending.markets) {
          if (BigInt(m.supplyAssets || "0") > 0n) {
            return { type: "lendingWithdraw", marketId: m.marketId, amount: "max", maxPriorityFeePerGasWei: unwindFee };
          }
        }
      }
      const lst = obs.protocols && obs.protocols.lst;
      if (lst && BigInt(lst.claimableWithdrawalWethWei || "0") > 0n) {
        return { type: "lstClaimWithdraw", maxPriorityFeePerGasWei: unwindFee };
      }
      const gmxPos = obs.protocols && obs.protocols.gmx && obs.protocols.gmx.position;
      if (gmxPos && BigInt(gmxPos.sizeUsd || "0") > 0n) {
        return {
          type: "gmxDecrease",
          isLong: gmxPos.isLong,
          collateral: gmxPos.collateral,
          collateralDeltaAmount: gmxPos.collateralAmount,
          sizeDeltaUsd: gmxPos.sizeUsd,
          maxPriorityFeePerGasWei: unwindFee,
        };
      }
      const stables = obs.balances.stables || {};
      for (const [sym, st] of Object.entries(stables)) {
        if (sym === "USDC" || !st.marketQuoted) continue;
        const bal = BigInt(st.balance || "0");
        const minU = 10n * 10n ** BigInt(st.decimals);
        const disc = (1 - st.priceUsdc) * 10000;
        if (bal >= minU && disc <= 25) {
          if (sym === "EUSD" && obs.protocols && obs.protocols.liquity) {
            return {
              type: "liquitySwapEusd",
              tokenIn: "EUSD",
              amountIn: bal.toString(),
              slippageBps: activeParams.pegArb.slippageBps,
              maxPriorityFeePerGasWei: unwindFee,
            };
          }
          if (sym !== "EUSD") {
            return {
              type: "stableSwap",
              stable: sym,
              tokenIn: sym,
              amountIn: bal.toString(),
              slippageBps: activeParams.pegArb.slippageBps,
              maxPriorityFeePerGasWei: unwindFee,
            };
          }
        }
      }
    }

    // 1. Circuit Breaker check
    const round = typeof obs.round === "number" ? obs.round : 0;
    if (round < vmState.trippedUntilBlock) {
      return { type: "noop", reason: `circuit breaker cooldown until block ${vmState.trippedUntilBlock}` };
    }
    const comp = obs.competition;
    if (
      comp &&
      typeof comp.recentSampleSize === "number" &&
      comp.recentSampleSize >= 4 &&
      typeof comp.recentRevertRate === "number" &&
      comp.recentRevertRate > activeParams.breaker.maxRevertRate &&
      activeParams.breaker.cooldownBlocks > 0 &&
      round > vmState.lastTrippedSampleRound
    ) {
      vmState.lastTrippedSampleRound = round + activeParams.breaker.cooldownBlocks;
      vmState.trippedUntilBlock = round + Math.max(0, activeParams.breaker.cooldownBlocks);
      return { type: "noop", reason: "circuit breaker tripped: high revert rate" };
    }
    if (obs.balances.ethWei && obs.inventory && Number.isFinite(obs.inventory.valueUsdc)) {
      const ethNow = BigInt(obs.balances.ethWei);
      const wethNow = BigInt(obs.balances.wethWei || "0");
      const lstObj = obs.protocols && obs.protocols.lst;
      const lstWethNow =
        BigInt((lstObj && lstObj.lstRedemptionValueWethWei) || "0") +
        BigInt((lstObj && lstObj.pendingWithdrawalWethWei) || "0") +
        BigInt((lstObj && lstObj.claimableWithdrawalWethWei) || "0");
      const totalEthNow = Number(ethNow + wethNow + lstWethNow) / 1e18;
      const wbtcNow = Number(BigInt((obs.baseBalances && obs.baseBalances.WBTC) || "0")) / 1e8;
      const valNow = obs.inventory.valueUsdc;
      const fNow = Number.isFinite(obs.fairPriceUsdcPerWeth) ? obs.fairPriceUsdcPerWeth : 3000;
      const fWbtc = (obs.fairPricesUsd && obs.fairPricesUsd.WBTC) || 60000;
      if (
        vmState.prevEthWei !== null &&
        vmState.prevTotalEth !== null &&
        vmState.prevWbtc !== null &&
        vmState.prevValUsdc !== null &&
        vmState.prevFairWeth !== null &&
        vmState.prevFairWbtc !== null
      ) {
        const ethDiff = ethNow < vmState.prevEthWei ? vmState.prevEthWei - ethNow : 0n;
        const stepGasEth = ethDiff > 0n && ethDiff <= 30000000000000000n ? Number(ethDiff) / 1e18 : 0;
        const stepGasUsd = stepGasEth * fNow;
        const passiveBetaUsd =
          vmState.prevTotalEth * (fNow - vmState.prevFairWeth) +
          vmState.prevWbtc * (fWbtc - vmState.prevFairWbtc);
        const stepGrossProfitUsd = (valNow - vmState.prevValUsdc) - passiveBetaUsd + stepGasUsd;
        if (stepGasUsd > 0 || Math.abs(stepGrossProfitUsd) > 0.05) {
          vmState.cumGasUsd += stepGasUsd;
          vmState.cumProfitUsd += stepGrossProfitUsd;
        }
      }
      vmState.prevEthWei = ethNow;
      vmState.prevTotalEth = totalEthNow;
      vmState.prevWbtc = wbtcNow;
      vmState.prevValUsdc = valNow;
      vmState.prevFairWeth = fNow;
      vmState.prevFairWbtc = fWbtc;
      if (vmState.cumGasUsd >= 15 && activeParams.breaker.cooldownBlocks > 0 && round > vmState.lastTrippedSampleRound) {
        const ratio = vmState.cumGasUsd / Math.max(0.01, vmState.cumProfitUsd);
        if (ratio > activeParams.breaker.maxGasToProfitRatio) {
          vmState.lastTrippedSampleRound = round + activeParams.breaker.cooldownBlocks;
          vmState.cumGasUsd = 0;
          vmState.cumProfitUsd = 0;
          vmState.trippedUntilBlock = round + Math.max(0, activeParams.breaker.cooldownBlocks);
          return { type: "noop", reason: "circuit breaker tripped: gasToProfitRatio exceeded" };
        }
      }
    }

    // 2. Classify Regime & Resolve Effective Weights
    let regime = activeParams.regime;
    const liq = obs.protocols && obs.protocols.liquity;
    if (regime === "unknown") {
      if (liq && (liq.recoveryMode || liq.discountBps >= 80 || (liq.riskiestTrove && liq.riskiestTrove.icr < liq.mcr))) {
        regime = "cdp-incident";
      } else {
        const stables = obs.balances.stables || {};
        for (const [sym, st] of Object.entries(stables)) {
          if (sym !== "USDC" && st.marketQuoted && st.priceUsdc < 0.992) {
            regime = "depeg";
            break;
          }
        }
      }
      if (regime === "unknown") {
        if ((obs.discoveredPools && obs.discoveredPools.length > 0) || (obs.registry && obs.registry.entries && obs.registry.entries.some((e) => e.kind === "uniswapV3Pool" || e.kind === "erc20"))) {
          regime = "launch";
        } else if (obs.registry && obs.registry.entries && obs.registry.entries.some((e) => !e.verified)) {
          regime = "vuln";
        } else {
          const rawHf = (obs.protocols && obs.protocols.aave && obs.protocols.aave.healthFactor) || "";
          const aaveHf = rawHf.includes(".") ? Number(rawHf) : Number(rawHf) / 1e18;
          if (Number.isFinite(aaveHf) && aaveHf > 0 && aaveHf < 1.0) {
            regime = "lending-incident";
          } else {
            const p = obs.protocols || {};
            const prices = [
              p.uniswap && p.uniswap.pool && p.uniswap.pool.priceUsdcPerWeth,
              p.balancer && p.balancer.priceUsdcPerWeth,
              p.curve && p.curve.priceUsdcPerWeth,
            ].filter((x) => typeof x === "number" && x > 0);
            if (prices.length >= 2 && (Math.max(...prices) / Math.min(...prices) - 1) * 10000 >= 250) {
              regime = "whale";
            } else {
              regime = "calm";
            }
          }
        }
      }
    }

    const w = { ...activeParams.weights };
    if (activeParams.regime === "unknown") {
      if (regime === "cdp-incident") {
        w.pegArb = Math.max(w.pegArb, 1);
        w.liquidation = Math.max(w.liquidation, 1);
      } else if (regime === "depeg") {
        w.pegArb = Math.max(w.pegArb, 1);
      } else if (regime === "lending-incident") {
        w.liquidation = Math.max(w.liquidation, 1);
      }
      const lst = obs.protocols && obs.protocols.lst;
      if (lst && (BigInt(lst.claimableWithdrawalWethWei || "0") > 0n || Math.abs(lst.discountBps) > 27)) {
        w.pegArb = Math.max(w.pegArb, 0.9);
      }
      if (obs.protocols && obs.protocols.lending && obs.protocols.lending.markets && obs.protocols.lending.markets.length > 0) {
        w.pegArb = Math.max(w.pegArb, 0.8);
      }
    }

    const effParams = clampSafetyParams(
      activeParams.regime === "unknown" && regime !== "calm"
        ? { ...activeParams, regime, weights: w }
        : { ...activeParams, weights: w },
    );
    const candidates = [];
    const fair = obs.fairPriceUsdcPerWeth;
    const usdcBal = BigInt(obs.balances.usdcUnits || "0");
    const wethBal = BigInt(obs.balances.wethWei || "0");
    const ethBal = BigInt(obs.balances.ethWei || "0");
    const views = buildMarketViews();
    let ammNoopReason = "no fundable gap worth taking";

    // Module A: AMM Arbitrage
    if (w.ammArb > 0 && Number.isFinite(fair) && fair > 0) {
      const isDefaultParity =
        effParams.ammArb.minGapBps <= 12 &&
        effParams.ammArb.sizeBps === 1000 &&
        effParams.regime === "unknown";
      const isThinBookRegime =
        effParams.regime === "cdp-incident" ||
        effParams.regime === "lending-incident" ||
        effParams.regime === "crash" ||
        effParams.regime === "spike";
      const maxSwapNotionalUsd = isThinBookRegime ? 7400 : 16000;
      const isIncidentAdaptive =
        !isDefaultParity &&
        (effParams.regime === "cdp-incident" || effParams.regime === "lending-incident");

      if (isIncidentAdaptive) {
        const gapThreshold = effParams.ammArb.minGapBps / 10000;
        const maxSizeCap = Math.max(3500, effParams.ammArb.sizeBps);
        const ranked = views
          .flatMap((vw) =>
            vw.venues.map((v) => ({
              base: vw.base,
              decimals: vw.baseDecimals,
              fair: vw.fair,
              swapType: v.swapType,
              price: v.price,
              feeBps: v.feeBps,
              gap: vw.fair / v.price - 1,
            })),
          )
          .filter((c) => Number.isFinite(c.gap) && Math.abs(c.gap) >= gapThreshold)
          .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

        for (const cand of ranked) {
          const edge = Math.abs(cand.gap);
          if (edge <= 0) continue;
          const buyBase = cand.gap > 0;
          const tokenIn = buyBase ? "USDC" : cand.base;
          if (!canFund(tokenIn)) continue;
          const szBps = Math.min(maxSizeCap, Math.max(250, Math.floor(edge * 250000)));
          const rawAmountIn = sized(tokenIn, szBps);
          const amountIn = capAmountByNotionalUsd(rawAmountIn, tokenIn, cand.decimals, cand.price, maxSwapNotionalUsd);
          if (amountIn === 0n) continue;
          const sizeUsd = tokenIn === "USDC" ? Number(amountIn) / 1e6 : (Number(amountIn) / 10 ** cand.decimals) * cand.fair;
          const profitUsd = sizeUsd * edge;
          if (edge * 10000 < 25 && isRivalAboveEvCeiling(profitUsd, SINGLE_GAS)) continue;
          const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
          if (!passesNetEvGate(profitUsd, fee, SINGLE_GAS, fair)) continue;
          const edgeBps = Math.abs(cand.gap) * 10000;
          const act = {
            type: cand.swapType,
            tokenIn,
            amountIn: amountIn.toString(),
            maxPriorityFeePerGasWei: fee,
            slippageBps: effParams.ammArb.slippageBps,
            ...(cand.base !== "WETH" ? { base: cand.base } : {}),
          };
          candidates.push({ module: "ammArb", action: act, expectedEdgeBps: edgeBps, reason: `ammArb ${cand.base} ${cand.swapType}` });
          ammNoopReason = "ok";
          break;
        }
      } else {
        // 2-leg cross-venue bundle check
        let bestTwo = null;
        if (usdcBal >= 1000000n) {
          for (const view of views) {
            if (view.venues.length < 2) continue;
            let cheap = view.venues[0];
            let rich = view.venues[0];
            for (const v of view.venues) {
              if (v.price < cheap.price) cheap = v;
              if (v.price > rich.price) rich = v;
            }
            if (cheap.swapType === rich.swapType || cheap.price <= 0 || rich.price <= 0) continue;
            const spreadBps = (rich.price / cheap.price - 1) * 10000;
            const roundtripCostBps = cheap.feeBps + rich.feeBps + (effParams.ammArb.minGapBps >= 40 ? effParams.ammArb.minGapBps : 50);
            const netEdgeBps = spreadBps - roundtripCostBps;
            if (netEdgeBps <= 0) continue;
            const twoLegCapBps = Math.max(3500, effParams.ammArb.sizeBps);
            const twoLegSizeBps =
              isDefaultParity && netEdgeBps < 200
                ? 1000
                : Math.min(twoLegCapBps, Math.max(250, Math.floor((netEdgeBps / 10000) * 250000)));
            const rawUsdcIn = (usdcBal * BigInt(twoLegSizeBps)) / 10000n;
            const usdcIn = capAmountByNotionalUsd(rawUsdcIn, "USDC", 6, 1, maxSwapNotionalUsd);
            if (usdcIn < 1000000n) continue;
            const boughtBase = Number(usdcIn) / 1e6 / cheap.price;
            const existingBase = Number(BigInt(view.baseBalanceWei || "0")) / 10 ** view.baseDecimals;
            const maxSellBase = maxSwapNotionalUsd / rich.price;
            const freshSell = boughtBase * 0.98;
            const drainBase = !isDefaultParity ? Math.min(existingBase, Math.max(0, maxSellBase - freshSell)) : 0;
            const sellF = isDefaultParity ? freshSell : drainBase + freshSell;
            const baseSell = sellF > 0 ? BigInt(Math.floor(sellF * 10 ** view.baseDecimals)) : 0n;
            if (baseSell <= 0n) continue;
            const profitUsd = (Number(usdcIn) / 1e6) * (netEdgeBps / 10000);
            if (netEdgeBps < 25 && isRivalAboveEvCeiling(profitUsd, TWO_GAS)) continue;
            const previewFee = computeBid(profitUsd, TWO_GAS, effParams.ammArb.priorityFeeMult);
            if (!passesNetEvGate(profitUsd, previewFee, TWO_GAS, fair)) continue;
            if (!bestTwo || profitUsd > bestTwo.profitUsd) {
              bestTwo = { base: view.base, cheap, rich, netEdgeBps, usdcIn, baseSell, profitUsd };
            }
          }
        }

        // WETH single-leg
        const p = obs.protocols || {};
        const wethView = views.find((vw) => vw.base === "WETH");
        const venues = [];
        if (effParams.ammArb.minGapBps >= 40 && wethView && wethView.venues.length > 0) {
          for (const v of wethView.venues) venues.push({ swapType: v.swapType, price: v.price, feeBps: v.feeBps });
        } else {
          if (p.uniswap && p.uniswap.pool) {
            venues.push({ swapType: "swap", price: p.uniswap.pool.priceUsdcPerWeth, feeBps: p.uniswap.pool.fee ? p.uniswap.pool.fee / 100 : 30 });
          }
          if (p.balancer) {
            venues.push({ swapType: "balancerSwap", price: p.balancer.priceUsdcPerWeth, feeBps: p.balancer.swapFeeBps || 30 });
          }
          if (p.curve) {
            venues.push({ swapType: "curveSwap", price: p.curve.priceUsdcPerWeth, feeBps: p.curve.feeBps || 4 });
          }
        }

        const isDirectionalRegime =
          effParams.regime === "cex-drift" ||
          effParams.regime === "spike" ||
          effParams.regime === "crash" ||
          effParams.regime === "cdp-incident" ||
          effParams.regime === "lending-incident" ||
          (isDefaultParity && (obs.round || 0) === 0);

        let best = null;
        let bestGap = effParams.ammArb.minGapBps / 10000;
        let bestProfitUsd = 0;
        for (const v of venues) {
          if (!Number.isFinite(v.price) || v.price <= 0) continue;
          const gap = Math.abs(fair / v.price - 1);
          const reqGap =
            effParams.ammArb.minGapBps >= 40
              ? (v.feeBps + effParams.ammArb.minGapBps) / 10000
              : isDirectionalRegime
                ? effParams.ammArb.minGapBps / 10000
                : Math.max(effParams.ammArb.minGapBps, v.feeBps + 12) / 10000;
          const tokenIn = v.price < fair ? "USDC" : "WETH";
          if (gap <= reqGap || !canFund(tokenIn)) continue;
          const netEdgeAfterFee = isDirectionalRegime ? gap : Math.max(0, gap - v.feeBps / 10000);
          if (netEdgeAfterFee <= 0) continue;

          if (isDefaultParity && gap < 0.021) {
            const amt = sized(tokenIn, 1000);
            if (amt === 0n) continue;
            const szUsd = tokenIn === "USDC" ? Number(amt) / 1e6 : (Number(amt) / 1e18) * fair;
            const prof = szUsd * netEdgeAfterFee;
            const fee = computeBid(prof, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
            if (!passesNetEvGate(prof, fee, SINGLE_GAS, fair)) continue;
            if (gap > bestGap) {
              bestGap = gap;
              bestProfitUsd = prof;
              best = v;
            }
          } else {
            const sizingEdge = effParams.ammArb.minGapBps >= 40 ? Math.max(0, gap - reqGap) : netEdgeAfterFee;
            const maxSizeCap = Math.max(3500, effParams.ammArb.sizeBps);
            const sizeGain = effParams.ammArb.minGapBps >= 40 ? 220000 : effParams.ammArb.sizeBps >= 2500 ? 400000 : 250000;
            const szBps = Math.min(maxSizeCap, Math.max(250, Math.floor(sizingEdge * sizeGain)));
            const rawAmt = sized(tokenIn, szBps);
            const amt = capAmountByNotionalUsd(rawAmt, tokenIn, 18, v.price, maxSwapNotionalUsd);
            if (amt === 0n) continue;
            const szUsd = tokenIn === "USDC" ? Number(amt) / 1e6 : (Number(amt) / 1e18) * (effParams.ammArb.minGapBps >= 40 ? v.price : fair);
            const prof = effParams.ammArb.minGapBps >= 40 ? szUsd * sizingEdge : szUsd * netEdgeAfterFee;
            if (netEdgeAfterFee * 10000 < 25 && isRivalAboveEvCeiling(prof, SINGLE_GAS)) continue;
            const fee = computeBid(prof, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
            if (!passesNetEvGate(prof, fee, SINGLE_GAS, fair)) continue;
            if (prof > bestProfitUsd) {
              bestProfitUsd = prof;
              bestGap = gap;
              best = v;
            }
          }
        }

        // Multi-base single-leg (WBTC)
        let bestMulti = null;
        for (const view of views) {
          if (view.base === "WETH") continue;
          for (const v of view.venues) {
            const gap = Math.abs(view.fair / v.price - 1);
            const minBaseGap = (v.feeBps + Math.max(50, effParams.ammArb.minGapBps)) / 10000;
            if (gap <= minBaseGap) continue;
            const buyBase = v.price < view.fair;
            const tokenIn = buyBase ? "USDC" : view.base;
            const sizingEdge = Math.max(0, gap - minBaseGap);
            const maxMultiCap = Math.max(3500, effParams.ammArb.sizeBps);
            const szBps =
              isDefaultParity && gap < 0.021
                ? 1000
                : Math.min(maxMultiCap, Math.max(250, Math.floor(sizingEdge * 250000)));
            const rawAmountIn = sizedBaseOrUsdc(usdcBal, view.baseBalanceWei, view.baseDecimals, buyBase, szBps);
            const amountIn = capAmountByNotionalUsd(rawAmountIn, tokenIn, view.baseDecimals, v.price, maxSwapNotionalUsd);
            if (amountIn === 0n) continue;
            const sizeUsd = tokenIn === "USDC" ? Number(amountIn) / 1e6 : (Number(amountIn) / 10 ** view.baseDecimals) * (effParams.ammArb.minGapBps >= 40 ? v.price : view.fair);
            const netEdgeAfterFee = Math.max(0, gap - v.feeBps / 10000);
            const profitUsd = effParams.ammArb.minGapBps >= 40 ? sizeUsd * sizingEdge : sizeUsd * netEdgeAfterFee;
            if (netEdgeAfterFee * 10000 < 25 && isRivalAboveEvCeiling(profitUsd, SINGLE_GAS)) continue;
            const previewFee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
            if (!passesNetEvGate(profitUsd, previewFee, SINGLE_GAS, fair)) continue;
            if (!bestMulti || profitUsd > bestMulti.profitUsd) {
              bestMulti = { base: view.base, venue: v, netEdgeBps: gap * 10000, tokenIn, amountIn, profitUsd };
            }
          }
        }

        const singleLegEdgeBps = best ? bestGap * 10000 : 0;
        let wethCand = null;
        let sizeBelowFloor = false;
        if (best) {
          const tokenIn = best.price < fair ? "USDC" : "WETH";
          const reqGap =
            effParams.ammArb.minGapBps >= 40
              ? (best.feeBps + effParams.ammArb.minGapBps) / 10000
              : isDirectionalRegime
                ? effParams.ammArb.minGapBps / 10000
                : Math.max(effParams.ammArb.minGapBps, best.feeBps + 12) / 10000;
          const netEdgeAfterFee = isDirectionalRegime ? bestGap : Math.max(0, bestGap - best.feeBps / 10000);
          const sizingEdge = effParams.ammArb.minGapBps >= 40 ? Math.max(0, bestGap - reqGap) : netEdgeAfterFee;
          const maxSizeCap = Math.max(3500, effParams.ammArb.sizeBps);
          const sizeGain = effParams.ammArb.minGapBps >= 40 ? 220000 : effParams.ammArb.sizeBps >= 2500 ? 400000 : 250000;
          const effSizeBps =
            isDefaultParity && bestGap < 0.021
              ? 1000
              : Math.min(maxSizeCap, Math.max(250, Math.floor(sizingEdge * sizeGain)));
          const rawAmountIn = sized(tokenIn, effSizeBps);
          const amountIn =
            isDefaultParity && bestGap < 0.021
              ? rawAmountIn
              : capAmountByNotionalUsd(rawAmountIn, tokenIn, 18, best.price, maxSwapNotionalUsd);
          if (amountIn > 0n) {
            const sizeUsd = tokenIn === "USDC" ? Number(amountIn) / 1e6 : (Number(amountIn) / 1e18) * (effParams.ammArb.minGapBps >= 40 ? best.price : fair);
            const netProfitBps = effParams.ammArb.minGapBps >= 40 ? sizingEdge : netEdgeAfterFee;
            const profitUsd = sizeUsd * netProfitBps;
            const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
            if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, fair)) {
              wethCand = {
                action: { type: best.swapType, tokenIn, amountIn: amountIn.toString(), maxPriorityFeePerGasWei: fee, slippageBps: effParams.ammArb.slippageBps },
                expectedEdgeBps: singleLegEdgeBps,
                profitUsd,
                reason: `ammArb ${best.swapType} ${tokenIn} gap=${singleLegEdgeBps.toFixed(1)}bps`,
              };
            }
          } else if (isDefaultParity) {
            sizeBelowFloor = true;
            ammNoopReason = "size below the floor";
          }
        }

        if (!sizeBelowFloor) {
          const preferTwoLeg = bestTwo !== null && (isDefaultParity ? bestTwo.netEdgeBps > singleLegEdgeBps : effParams.ammArb.minGapBps >= 40 || bestTwo.netEdgeBps > singleLegEdgeBps);
          if (bestTwo && preferTwoLeg) {
            const fee = computeBid(bestTwo.profitUsd, TWO_GAS, effParams.ammArb.priorityFeeMult);
            candidates.push({
              module: "ammArb",
              expectedEdgeBps: bestTwo.netEdgeBps,
              reason: `ammArb 2-leg ${bestTwo.base}`,
              action: {
                type: "bundle",
                actions: [
                  { type: bestTwo.cheap.swapType, tokenIn: "USDC", amountIn: bestTwo.usdcIn.toString(), slippageBps: effParams.ammArb.slippageBps, ...(bestTwo.base !== "WETH" ? { base: bestTwo.base } : {}) },
                  { type: bestTwo.rich.swapType, tokenIn: bestTwo.base, amountIn: bestTwo.baseSell.toString(), slippageBps: effParams.ammArb.slippageBps, ...(bestTwo.base !== "WETH" ? { base: bestTwo.base } : {}) },
                ],
                maxPriorityFeePerGasWei: fee,
              },
            });
            ammNoopReason = "ok";
          } else if (wethCand && (isDefaultParity || !bestMulti || wethCand.profitUsd >= bestMulti.profitUsd)) {
            candidates.push({ module: "ammArb", action: wethCand.action, expectedEdgeBps: wethCand.expectedEdgeBps, reason: wethCand.reason });
            ammNoopReason = "ok";
          } else if (bestMulti) {
            const fee = computeBid(bestMulti.profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
            candidates.push({
              module: "ammArb",
              expectedEdgeBps: bestMulti.netEdgeBps,
              reason: `ammArb ${bestMulti.base} ${bestMulti.venue.swapType}`,
              action: {
                type: bestMulti.venue.swapType,
                base: bestMulti.base,
                tokenIn: bestMulti.tokenIn,
                amountIn: bestMulti.amountIn.toString(),
                maxPriorityFeePerGasWei: fee,
                slippageBps: effParams.ammArb.slippageBps,
              },
            });
            ammNoopReason = "ok";
          }
        }
      }
    }

    // Module B: Peg, LST & Verified Registry Arbitrage
    if (w.pegArb > 0) {
      let pegAdded = false;
      const safeFair = Number.isFinite(fair) && fair > 0 ? fair : 3000;
      if (vmState.pegBaseEthWei === null) vmState.pegBaseEthWei = ethBal;
      if (wethBal < vmState.pendingRedeemedWethWei) vmState.pendingRedeemedWethWei = wethBal;

      if (liq) {
        const canSellEth = Array.isArray(obs.enabledProtocols) ? obs.enabledProtocols.includes("uniswap") : Boolean(obs.protocols && obs.protocols.uniswap && obs.protocols.uniswap.pool);
        const wethBaselineWei = wethBal > vmState.pendingRedeemedWethWei ? wethBal - vmState.pendingRedeemedWethWei : 0n;
        const eusd = BigInt(liq.eusdBalanceWei || "0");
        const sellable = wethBal > wethBaselineWei ? wethBal - wethBaselineWei : 0n;
        const sugRes = BigInt(liq.suggestedGasReserveWei || "0");
        const reserve = vmState.pegBaseEthWei > sugRes ? vmState.pegBaseEthWei : sugRes;

        if (canSellEth && sellable >= 10n ** 16n) {
          const profitUsd = Math.max(15, (Number(sellable) / 1e18) * safeFair * 0.015);
          const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
          if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
            vmState.pendingRedeemedWethWei = vmState.pendingRedeemedWethWei > sellable ? vmState.pendingRedeemedWethWei - sellable : 0n;
            candidates.push({
              module: "pegArb",
              expectedEdgeBps: 150,
              reason: "pegArb unwind redeemed WETH to USDC",
              action: { type: "swap", tokenIn: "WETH", amountIn: sellable.toString(), slippageBps: effParams.pegArb.slippageBps, maxPriorityFeePerGasWei: fee },
            });
            pegAdded = true;
          }
        } else if (canSellEth && ethBal > reserve + 10n ** 16n) {
          const wrapEth = ethBal - reserve;
          const profitUsd = Math.max(15, (Number(wrapEth) / 1e18) * safeFair * 0.014);
          const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
          if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
            vmState.pendingRedeemedWethWei += wrapEth;
            candidates.push({
              module: "pegArb",
              expectedEdgeBps: 140,
              reason: "pegArb wrap redeemed ETH to WETH",
              action: { type: "rawTx", tx: { to: WETH_ADDR, data: "0xd0e30db0", value: wrapEth.toString() }, maxPriorityFeePerGasWei: fee },
            });
            pegAdded = true;
          }
        } else if (liq.marketQuoted && eusd >= 200n * 10n ** 18n) {
          const redeemEdge = liq.redemptionEdgeBps - 35;
          if (liq.discountBps <= 0) {
            const edgeBps = Math.max(25, -liq.discountBps);
            const profitUsd = (Number(eusd) / 1e18) * (edgeBps / 10000);
            const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
            if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
              candidates.push({
                module: "pegArb",
                expectedEdgeBps: edgeBps,
                reason: "pegArb sell eUSD above par",
                action: { type: "liquitySwapEusd", tokenIn: "EUSD", amountIn: eusd.toString(), slippageBps: effParams.pegArb.slippageBps, maxPriorityFeePerGasWei: fee },
              });
              pegAdded = true;
            }
          } else if (redeemEdge > 0 && liq.redemptionRateBps <= effParams.pegArb.maxRedemptionFeeBps) {
            const edgeBps = Math.max(25, redeemEdge);
            const profitUsd = (Number(eusd) / 1e18) * (edgeBps / 10000);
            const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
            if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
              candidates.push({
                module: "pegArb",
                expectedEdgeBps: edgeBps,
                reason: "pegArb redeem eUSD",
                action: { type: "liquityRedeem", amountEusdWei: eusd.toString(), maxFeeBps: Math.round(effParams.pegArb.maxRedemptionFeeBps), maxPriorityFeePerGasWei: fee },
              });
              pegAdded = true;
            }
          }
        } else if (
          liq.marketQuoted &&
          effParams.regime !== "cdp-incident" &&
          liq.discountBps >= effParams.pegArb.minDiscountBps &&
          liq.redemptionRateBps <= effParams.pegArb.maxRedemptionFeeBps
        ) {
          const buyEdge = liq.discountBps - liq.redemptionRateBps - 35 - 20;
          if (buyEdge > 0 && usdcBal >= 200000000n) {
            let sz = (usdcBal * 3000n) / 10000n;
            if (liq.poolReserves) {
              const poolEusd = BigInt(liq.poolReserves.eusd);
              const poolUsdc = BigInt(liq.poolReserves.usdc);
              if (poolEusd > 0n) {
                const capUsdc = (poolEusd * 1000n) / 10000n / 10n ** 12n;
                if (capUsdc > 0n && capUsdc < sz) sz = capUsdc;
              }
              const eusd6 = poolEusd / 10n ** 12n;
              const imb = eusd6 > poolUsdc ? (eusd6 - poolUsdc) / 2n : 0n;
              const room = liq.discountBps - (liq.redemptionRateBps + 35) - 20;
              if (imb > 0n && liq.discountBps > 0) {
                const aff = room > 0 ? (imb * BigInt(Math.floor(room * 1000))) / BigInt(Math.ceil(3 * liq.discountBps * 1000)) : 0n;
                if (aff < sz) sz = aff;
              }
            }
            const effPegBps = Math.max(
              effParams.pegArb.sizeBps,
              liq.discountBps >= 120 ? Math.min(3500, Math.floor(liq.discountBps * 14)) : effParams.pegArb.sizeBps,
            );
            const desiredUsdc = (usdcBal * BigInt(effPegBps)) / 10000n;
            const cappedUsdc = desiredUsdc < sz ? desiredUsdc : sz;
            if (cappedUsdc >= 200000000n) {
              const profitUsd = (Number(cappedUsdc) / 1e6) * (buyEdge / 10000);
              const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
              if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
                candidates.push({
                  module: "pegArb",
                  expectedEdgeBps: buyEdge,
                  reason: "pegArb buy discounted eUSD",
                  action: { type: "liquitySwapEusd", tokenIn: "USDC", amountIn: cappedUsdc.toString(), slippageBps: effParams.pegArb.slippageBps, maxPriorityFeePerGasWei: fee },
                });
                pegAdded = true;
              }
            }
          }
        }
      }

      if (!pegAdded) {
        const stables = obs.balances.stables || {};
        for (const [symbol, s] of Object.entries(stables)) {
          if (symbol === "USDC" || symbol === "EUSD" || !s.marketQuoted) continue;
          const balance = BigInt(s.balance || "0");
          const discountBps = (1 - s.priceUsdc) * 10000;
          const minHolding = 10n * 10n ** BigInt(s.decimals);
          if (balance >= minHolding && discountBps <= 10) {
            const edgeBps = Math.max(30, -discountBps + 25);
            const profitUsd = Math.max(10, (Number(balance) / 10 ** s.decimals) * (edgeBps / 10000));
            const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
            if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
              candidates.push({
                module: "pegArb",
                expectedEdgeBps: edgeBps,
                reason: `pegArb unwind ${symbol}`,
                action: { type: "stableSwap", stable: symbol, tokenIn: symbol, amountIn: balance.toString(), slippageBps: effParams.pegArb.slippageBps, maxPriorityFeePerGasWei: fee },
              });
              pegAdded = true;
              break;
            }
          }
          if (effParams.regime !== "depeg-persist" && discountBps >= effParams.pegArb.minDiscountBps && usdcBal >= 200000000n) {
            const effStableBps = Math.max(
              effParams.pegArb.sizeBps,
              discountBps >= 120 ? Math.min(3500, Math.floor(discountBps * 14)) : effParams.pegArb.sizeBps,
            );
            const buyUsdc = (usdcBal * BigInt(effStableBps)) / 10000n;
            if (buyUsdc >= 200000000n) {
              const edgeBps = discountBps - 20;
              const profitUsd = (Number(buyUsdc) / 1e6) * (edgeBps / 10000);
              const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
              if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
                candidates.push({
                  module: "pegArb",
                  expectedEdgeBps: edgeBps,
                  reason: `pegArb buy discounted ${symbol}`,
                  action: { type: "stableSwap", stable: symbol, tokenIn: "USDC", amountIn: buyUsdc.toString(), slippageBps: effParams.pegArb.slippageBps, maxPriorityFeePerGasWei: fee },
                });
                pegAdded = true;
                break;
              }
            }
          }
        }
      }

      if (!pegAdded) {
        const lst = obs.protocols && obs.protocols.lst;
        if (lst) {
          const lstBal = BigInt(lst.lstBalanceWei || "0");
          const claimable = BigInt(lst.claimableWithdrawalWethWei || "0");
          const qDelay = lst.estimatedQueueDelayBlocks !== undefined ? lst.estimatedQueueDelayBlocks : lst.withdrawalDelayBlocks;
          const mDelay = lst.queueDelayPerWethBlocks !== undefined ? lst.queueDelayPerWethBlocks : qDelay;
          const canQueue = rem === undefined || rem > mDelay + 4;
          const quoted = lst.marketQuoted !== false;
          const cEdge = quoted ? lst.discountBps - 27 : -1e9;

          const tp = BigInt(lst.queueThroughputWeiPerBlock || "0");
          const redVal = BigInt(lst.lstRedemptionValueWethWei || "0");
          const drainB = rem !== undefined ? rem - mDelay - 4 : 999;
          const affAssets = drainB > 0 ? BigInt(drainB) * tp : 0n;
          const qShares =
            tp <= 0n || rem === undefined || redVal <= 0n
              ? lstBal
              : drainB <= 0
                ? 0n
                : affAssets >= redVal
                  ? lstBal
                  : (lstBal * affAssets) / redVal;
          const harvSize = lstBal < wethBal ? lstBal : wethBal;

          if (claimable > 0n) {
            const profitUsd = Math.max(25, (Number(claimable) / 1e18) * safeFair * 0.01);
            const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
            if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
              candidates.push({ module: "pegArb", expectedEdgeBps: 300, reason: "lstArb claim finalized LST withdrawal", action: { type: "lstClaimWithdraw", maxPriorityFeePerGasWei: fee } });
              pegAdded = true;
            }
          } else if (canQueue && lstBal >= 10n ** 15n && cEdge > 0 && qShares >= 10n ** 15n) {
            const profitUsd = (Number(qShares) / 1e18) * safeFair * Math.max(0.003, lst.discountBps / 10000);
            const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
            if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
              candidates.push({
                module: "pegArb",
                expectedEdgeBps: Math.max(40, lst.discountBps - 12),
                reason: "lstArb queue redemption",
                action: { type: "lstRequestWithdraw", amountLstWei: qShares.toString(), maxPriorityFeePerGasWei: fee },
              });
              pegAdded = true;
            }
          } else if (canQueue && cEdge > 0 && wethBal / 2n >= 10n ** 15n) {
            const wethIn = wethBal / 2n;
            const eBps = Math.max(25, lst.discountBps - 27);
            const profitUsd = (Number(wethIn) / 1e18) * safeFair * (eBps / 10000);
            const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
            if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
              candidates.push({
                module: "pegArb",
                expectedEdgeBps: eBps,
                reason: "lstArb buy discounted LST",
                action: { type: "lstSwap", tokenIn: "WETH", amountIn: wethIn.toString(), slippageBps: effParams.pegArb.slippageBps, maxPriorityFeePerGasWei: fee },
              });
              pegAdded = true;
            }
          } else if (quoted && lstBal >= 10n ** 15n && -lst.discountBps > 27 && harvSize >= 10n ** 15n) {
            const pBps = Math.max(25, -lst.discountBps - 27);
            const profitUsd = (Number(harvSize) / 1e18) * safeFair * (pBps / 10000);
            const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
            if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
              candidates.push({
                module: "pegArb",
                expectedEdgeBps: pBps,
                reason: "lstArb harvest LST premium",
                action: { type: "lstSwap", tokenIn: "LST", amountIn: harvSize.toString(), slippageBps: effParams.pegArb.slippageBps, maxPriorityFeePerGasWei: fee },
              });
              pegAdded = true;
            }
          } else if (canQueue && lst.apyBps >= 200 && wethBal > 0n && lst.yieldPerBlockBps > 0 && (effParams.regime === "calm" || effParams.regime === "depeg-persist")) {
            const staked = BigInt(lst.lstRedemptionValueWethWei || "0") + BigInt(lst.pendingWithdrawalWethWei || "0");
            const book = wethBal + staked;
            const target = (book * 7000n) / 10000n;
            if (target > staked + (book * 500n) / 10000n) {
              const stakeIn = target - staked < wethBal ? target - staked : wethBal;
              const remBlocks = rem !== undefined ? rem : 360;
              const expectedYieldBps = lst.yieldPerBlockBps * Math.min(remBlocks, 180);
              if (stakeIn >= 10n ** 15n && expectedYieldBps >= 20) {
                const profitUsd = (Number(stakeIn) / 1e18) * safeFair * (expectedYieldBps / 10000);
                const fee = computeBid(profitUsd, SINGLE_GAS, 1);
                if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
                  candidates.push({
                    module: "pegArb",
                    expectedEdgeBps: Math.min(22, expectedYieldBps),
                    reason: "lstArb stake WETH for yield",
                    action: { type: "lstDeposit", amountWethWei: stakeIn.toString(), maxPriorityFeePerGasWei: fee },
                  });
                  pegAdded = true;
                }
              }
            }
          }
        }
      }

      if (!pegAdded) {
        const lending = obs.protocols && obs.protocols.lending;
        const regEntries = (obs.registry && obs.registry.entries) || [];
        if (lending && lending.singleton && Array.isArray(lending.markets) && (rem === undefined || rem > 20) && usdcBal >= 100000000n) {
          for (const m of lending.markets) {
            const key = m.marketId.toLowerCase();
            if (vmState.avoidedReg.has(key) || vmState.tradedReg.has(key)) continue;
            if (BigInt(m.supplyAssets || "0") > 0n) {
              vmState.tradedReg.add(key);
              continue;
            }
            const entry = regEntries.find((e) => e.kind === "lendingMarket" && e.extra && String(e.extra).toLowerCase() === key);
            if (!entry || entry.mine) continue;
            const codeOk = entry.codehashNow === undefined || entry.codehashNow.toLowerCase() === entry.codehashAtRegistration.toLowerCase();
            const zeroOracle = entry.oracleOwner !== undefined && entry.oracleOwner.toLowerCase() === ZERO_ADDR;
            if (!entry.verified || !codeOk || !zeroOracle) {
              vmState.avoidedReg.add(key);
              continue;
            }
            const supplyAmt = (usdcBal * 2000n) / 10000n;
            if (supplyAmt >= 100000000n) {
              const profitUsd = Math.max(8, (Number(supplyAmt) / 1e6) * 0.008);
              const fee = computeBid(profitUsd, SINGLE_GAS, effParams.ammArb.priorityFeeMult);
              if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
                vmState.tradedReg.add(key);
                candidates.push({
                  module: "pegArb",
                  expectedEdgeBps: 55,
                  reason: `verified registry lendingSupply ${m.marketId}`,
                  action: { type: "lendingSupply", marketId: m.marketId, amount: supplyAmt.toString(), maxPriorityFeePerGasWei: fee },
                });
                break;
              }
            }
          }
        }
      }
    }

    // Module C: Liquidation Sniper
    if (w.liquidation > 0) {
      const safeFair = Number.isFinite(fair) && fair > 0 ? fair : 3000;
      const p = obs.protocols || {};
      const maxAmmWethPrice = Math.max(
        (p.uniswap && p.uniswap.pool && p.uniswap.pool.priceUsdcPerWeth) || 0,
        (p.balancer && p.balancer.priceUsdcPerWeth) || 0,
        (p.curve && p.curve.priceUsdcPerWeth) || 0,
      );
      const activeWethCrashSell = wethBal > 50000000000000000n && maxAmmWethPrice > safeFair * 1.002;
      let liqAdded = false;

      if (liq) {
        const r = liq.riskiestTrove;
        if (r) {
          const underMcr = r.icr < liq.mcr - 0.005;
          const entireDebt = BigInt(r.netDebtEusdWei || "0") + 200n * 10n ** 18n;
          const underTcr = liq.recoveryMode && r.icr < liq.tcr - 0.005 && entireDebt <= BigInt(liq.spTotalDepositsEusdWei || "0");
          if ((underMcr || underTcr) && !activeWethCrashSell) {
            const debtUsd = Number(r.netDebtEusdWei || "0") / 1e18;
            const profitUsd = Math.max(200, debtUsd * 0.05);
            const fee = computeBid(profitUsd, SINGLE_GAS, effParams.liquidation.priorityFeeMult);
            if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
              candidates.push({
                module: "liquidation",
                expectedEdgeBps: Math.max(effParams.liquidation.minBonusBps, 500),
                reason: `liquidation liquityLiquidate ${r.owner}`,
                action: { type: "liquityLiquidate", borrowers: [r.owner], maxPriorityFeePerGasWei: fee },
              });
              liqAdded = true;
            }
          }
        }
        if (!liqAdded) {
          const gainUsd = (Number(liq.spEthGainWei || "0") / 1e18) * liq.priceUsd;
          if (gainUsd >= 50) {
            const profitUsd = Math.max(15, gainUsd * 0.1);
            const fee = computeBid(profitUsd, SINGLE_GAS, effParams.liquidation.priorityFeeMult);
            if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
              candidates.push({
                module: "liquidation",
                expectedEdgeBps: 350,
                reason: "liquidation claim SP ETH gain",
                action: { type: "liquityWithdrawFromSP", amountEusdWei: "0", maxPriorityFeePerGasWei: fee },
              });
              liqAdded = true;
            }
          }
        }
        if (!liqAdded) {
          const eusdWei = BigInt(liq.eusdBalanceWei || "0");
          if (effParams.regime === "cdp-incident" && eusdWei >= 200n * 10n ** 18n && Boolean(liq.riskiestTrove) && !activeWethCrashSell) {
            const profitUsd = (Number(eusdWei) / 1e18) * 0.025;
            const fee = computeBid(profitUsd, SINGLE_GAS, effParams.liquidation.priorityFeeMult);
            if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
              candidates.push({
                module: "liquidation",
                expectedEdgeBps: 250,
                reason: "liquidation provide eUSD to Stability Pool",
                action: { type: "liquityProvideToSP", amountEusdWei: eusdWei.toString(), maxPriorityFeePerGasWei: fee },
              });
              liqAdded = true;
            }
          }
        }
      }

      if (!liqAdded && p.aave && !activeWethCrashSell) {
        const rawHf = p.aave.healthFactor || "";
        const hf = rawHf.includes(".") ? Number(rawHf) : Number(rawHf) / 1e18;
        const victimEnv =
          typeof process !== "undefined" && process.env && process.env.ERIS_LIQUIDATION_VICTIMS
            ? process.env.ERIS_LIQUIDATION_VICTIMS
            : (ctx &&
                typeof ctx === "object" &&
                (Reflect.get(ctx, "__victimEnv") ||
                  (ctx.config && typeof ctx.config === "object" && Reflect.get(ctx.config, "__victimEnv")))) ||
              "";
        const targetVictim = String(victimEnv).split(",").map((s) => s.trim()).filter(Boolean)[0];
        if (targetVictim && Number.isFinite(hf) && hf > 0 && hf < effParams.liquidation.maxHealthFactor) {
          if (usdcBal >= 100000000n) {
            const expectedProfitUsd = Math.max(100, (Number(usdcBal) / 1e6) * (effParams.liquidation.minBonusBps / 10000));
            const fee = computeBid(expectedProfitUsd, SINGLE_GAS, effParams.liquidation.priorityFeeMult);
            if (passesNetEvGate(expectedProfitUsd, fee, SINGLE_GAS, safeFair)) {
              const padAddr = (a = "") => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
              const data = "0x00a718a9" + padAddr(WETH_ADDR) + padAddr(USDC_ADDR) + padAddr(targetVictim) + "f".repeat(64) + "0".repeat(64);
              candidates.push({
                module: "liquidation",
                expectedEdgeBps: Math.max(effParams.liquidation.minBonusBps, 500),
                reason: `liquidation aave liquidationCall ${targetVictim}`,
                action: { type: "rawTx", tx: { to: AAVE_POOL_ADDR, data }, maxPriorityFeePerGasWei: fee },
              });
              liqAdded = true;
            }
          }
          if (!liqAdded && wethBal >= 100000000000000000n) {
            const richV = [];
            if (p.uniswap && p.uniswap.pool) richV.push({ swapType: "swap", price: p.uniswap.pool.priceUsdcPerWeth });
            if (p.balancer) richV.push({ swapType: "balancerSwap", price: p.balancer.priceUsdcPerWeth });
            if (p.curve) richV.push({ swapType: "curveSwap", price: p.curve.priceUsdcPerWeth });
            let bestRich = null;
            for (const rv of richV) {
              if (Number.isFinite(rv.price) && rv.price > 0 && (!bestRich || rv.price > bestRich.price)) bestRich = rv;
            }
            if (bestRich) {
              const swapWeth = wethBal / 4n >= 100000000000000000n ? wethBal / 4n : 100000000000000000n;
              const expectedProfitUsd = (Number(swapWeth) / 1e18) * safeFair * 0.04;
              const fee = computeBid(expectedProfitUsd, SINGLE_GAS, effParams.liquidation.priorityFeeMult);
              if (passesNetEvGate(expectedProfitUsd, fee, SINGLE_GAS, safeFair)) {
                candidates.push({
                  module: "liquidation",
                  expectedEdgeBps: Math.max(effParams.liquidation.minBonusBps, 450),
                  reason: `liquidation acquire USDC debt token via ${bestRich.swapType}`,
                  action: {
                    type: bestRich.swapType,
                    tokenIn: "WETH",
                    amountIn: swapWeth.toString(),
                    slippageBps: effParams.ammArb.slippageBps,
                    maxPriorityFeePerGasWei: fee,
                  },
                });
                liqAdded = true;
              }
            }
          }
        }
      }

      if (!liqAdded && p.gmx) {
        const pos = p.gmx.position;
        if (pos && BigInt(pos.sizeUsd || "0") > 0n) {
          const collUnits = Number(pos.collateralAmount || "0") / 1e6;
          const marginRatio = collUnits > 0 ? (collUnits + pos.pnlUsd) / collUnits : 1;
          const fundingDrag = (pos.fundingOwedUsd || 0) > 25;
          if (marginRatio < 0.35 || fundingDrag || effParams.regime === "calm") {
            const profitUsd = Math.max(50, collUnits * 0.1);
            const fee = computeBid(profitUsd, SINGLE_GAS, effParams.liquidation.priorityFeeMult);
            if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
              candidates.push({
                module: "liquidation",
                expectedEdgeBps: 400,
                reason: "liquidation gmxDecrease unwind",
                action: {
                  type: "gmxDecrease",
                  isLong: pos.isLong,
                  collateral: pos.collateral,
                  collateralDeltaAmount: pos.collateralAmount,
                  sizeDeltaUsd: pos.sizeUsd,
                  maxPriorityFeePerGasWei: fee,
                },
              });
              liqAdded = true;
            }
          }
        } else if (effParams.regime === "crash" && !activeWethCrashSell && usdcBal >= 1500000000n && wethBal >= 1000000000000000000n) {
          const collAmount = usdcBal / 10n;
          const collUsd = BigInt(Math.floor(Number(collAmount) / 1e6));
          const sizeDeltaUsd = collUsd * 2n * 10n ** 30n;
          const profitUsd = Number(collUsd) * 0.06;
          const fee = computeBid(profitUsd, SINGLE_GAS, effParams.liquidation.priorityFeeMult);
          if (passesNetEvGate(profitUsd, fee, SINGLE_GAS, safeFair)) {
            candidates.push({
              module: "liquidation",
              expectedEdgeBps: 280,
              reason: "liquidation open defensive GMX short hedge in crash regime",
              action: {
                type: "gmxIncrease",
                isLong: false,
                collateral: "USDC",
                collateralAmount: collAmount.toString(),
                sizeDeltaUsd: sizeDeltaUsd.toString(),
                maxPriorityFeePerGasWei: fee,
              },
            });
          }
        }
      }
    }

    if (candidates.length === 0) {
      return { type: "noop", reason: ammNoopReason };
    }

    candidates.sort((a, b) => b.expectedEdgeBps * w[b.module] - a.expectedEdgeBps * w[a.module]);
    return JSON.parse(JSON.stringify(candidates[0].action));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "noop", reason: `vm fallback: ${msg}` };
  }
  // === END_EXECUTOR_BODY ===
}
