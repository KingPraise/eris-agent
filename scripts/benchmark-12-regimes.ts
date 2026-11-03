/**
 * scripts/benchmark-12-regimes.ts
 *
 * Head-to-head backtest simulation across all 12 official ASCON regimes
 * (`config/scenarios/public.yaml`: 12 regimes × 5 public seeds = 60 epochs of 360 blocks)
 * comparing `dynasty-alpha` against the official reference agent roster:
 *   - noop (benchmark baseline, §4.3)
 *   - my-arb
 *   - venue-arb
 *   - multi-arb
 *   - clean-arb
 *   - max-profit-arb
 *   - adaptive-arb
 *   - redemption-arb
 *   - peg-arb
 *   - sp-underwriter
 *   - lst-carry
 *
 * Uses the repository's official `scoreCompetition` / `computeStandings` (`core/src/scoring/deviationScore.ts`
 * and `core/src/backtest/standings.ts`) to compute exact USDC PnL (`P(a, s) = V_K - V_0`) and
 * standardized Deviation Scores (`T(a, s) = 50 + 10 (P - mu) / sigma` and weighted `Score(a)`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type {
  AgentAction,
  AgentContext,
  AgentObservation,
  BundleActionItem,
  LiquityObservation,
  LstObservation,
} from "@eris/sdk";
import { Rng } from "@eris/sdk/rng.js";
import * as constants from "@eris/sdk/constants.js";
import { computeStandings, type ScenarioResult } from "../core/src/backtest/standings.js";
import { round2 } from "../core/src/scoring/deviationScore.js";
import { extractExecutorBody } from "../example/agents/dynasty-alpha/agent.js";
import { Engine } from "../example/agents/dynasty-alpha/engine/Engine.js";
import { resetPegBaselines } from "../example/agents/dynasty-alpha/modules/pegArb.js";
import { DEFAULT_PARAMS, type RegimeId, type Tuning } from "../example/agents/dynasty-alpha/StrategyTuning.js";
import { compileExecutor } from "../example/agents/runtime/improve.js";
import { decide as decideMyArb } from "../example/agents/my-arb/agent.js";
import { decide as decideVenueArb } from "../example/agents/venue-arb/agent.js";
import { decide as decideMultiArb } from "../example/agents/multi-arb/agent.js";
import { decide as decideCleanArb } from "../example/agents/clean-arb/agent.js";
import { decide as decideMaxProfitArb } from "../example/agents/max-profit-arb/agent.js";
import { decide as decideAdaptiveArb } from "../example/agents/adaptive-arb/agent.js";
import { decide as decideRedemptionArb } from "../example/agents/redemption-arb/agent.js";
import { decide as decidePegArb } from "../example/agents/peg-arb/agent.js";
import { decide as decideSpUnderwriter } from "../example/agents/sp-underwriter/agent.js";
import { decide as decideLstCarry } from "../example/agents/lst-carry/agent.js";

const BLOCKS_PER_EPOCH = 360;
const INITIAL_WETH = 8.0;
const INITIAL_WBTC = 0.4;
const INITIAL_ETH = 1.0;
const INITIAL_USDC = 25_000.0;
const INITIAL_FAIR_WETH = 3000.0;
const INITIAL_FAIR_WBTC = 60_000.0;

type AgentWallet = {
  id: string;
  baseline?: boolean;
  usdc: number;
  weth: number;
  wbtc: number;
  eth: number;
  dai: number;
  eusd: number;
  spEusd: number;
  spEthGain: number;
  lst: number;
  pendingLstWeth: number;
  claimableLstWeth: number;
  lstUnlockBlock: number;
  lendingSupplyUsdc: number;
  gmxCollateralUsdc: number;
  gmxShortNotionalUsd: number;
  gmxEntryPrice: number;
  txCount: number;
  revertCount: number;
  gasSpentEth: number;
  recentReverts: boolean[];
};

function makeWallet(id: string, baseline = false): AgentWallet {
  return {
    id,
    baseline,
    usdc: INITIAL_USDC,
    weth: INITIAL_WETH,
    wbtc: INITIAL_WBTC,
    eth: INITIAL_ETH,
    dai: 0,
    eusd: 0,
    spEusd: 0,
    spEthGain: 0,
    lst: 0,
    pendingLstWeth: 0,
    claimableLstWeth: 0,
    lstUnlockBlock: 9999,
    lendingSupplyUsdc: 0,
    gmxCollateralUsdc: 0,
    gmxShortNotionalUsd: 0,
    gmxEntryPrice: INITIAL_FAIR_WETH,
    txCount: 0,
    revertCount: 0,
    gasSpentEth: 0,
    recentReverts: [],
  };
}

function markPortfolioUsdc(
  w: AgentWallet,
  state: MarketState,
  isFinalBlock: boolean,
): number {
  const gmxPnl =
    w.gmxShortNotionalUsd > 0
      ? w.gmxShortNotionalUsd * (1 - state.fairWeth / w.gmxEntryPrice)
      : 0;
  const gmxEquity =
    w.gmxCollateralUsdc > 0 ? Math.max(0, w.gmxCollateralUsdc + gmxPnl) : 0;
  // ADR 0022 round-trip rule: registry lending supply still inside a venue at the final block is worth 0!
  const lendingValue = isFinalBlock ? 0 : w.lendingSupplyUsdc;
  const lstPriceWeth = state.lstRedemptionRate * (1 - state.lstDiscountBps / 10_000);
  const lstValueWeth =
    w.lst * lstPriceWeth + w.pendingLstWeth + w.claimableLstWeth;

  return (
    w.usdc +
    w.weth * state.fairWeth +
    w.wbtc * state.fairWbtc +
    w.eth * state.fairWeth +
    w.dai * state.daiPriceUsdc +
    (w.eusd + w.spEusd) * state.eusdPriceUsdc +
    w.spEthGain * state.fairWeth +
    lstValueWeth * state.fairWeth +
    lendingValue +
    gmxEquity
  );
}

type MarketState = {
  block: number;
  blocksRemaining: number;
  regime: string;
  fairWeth: number;
  fairWbtc: number;
  uniWeth: number;
  balWeth: number;
  curveWeth: number;
  uniWbtc: number;
  balWbtc: number;
  curveWbtc: number;
  depthFactor: number;
  daiPriceUsdc: number;
  eusdPriceUsdc: number;
  eusdDiscountBps: number;
  redemptionRateBps: number;
  troveIcr: number;
  troveDebtEusd: number;
  troveLiquidated: boolean;
  aaveVictimHf: number;
  aaveVictimLiquidated: boolean;
  lstDiscountBps: number;
  lstRedemptionRate: number;
  hasVerifiedRegistryMarket: boolean;
  hasUnverifiedPool: boolean;
  maxCompetitorFeeWei: bigint;
};

function randNormal(rng: Rng, mean = 0, std = 1): number {
  return mean + std * rng.gaussian();
}

function randUniform(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng.next();
}

function stepMarketState(
  prev: MarketState,
  block: number,
  regime: string,
  rng: Rng,
): MarketState {
  const blocksRemaining = BLOCKS_PER_EPOCH - block;
  let fairWeth = prev.fairWeth * (1 + randNormal(rng, 0, 0.0018));
  let fairWbtc = prev.fairWbtc * (1 + randNormal(rng, 0, 0.0018));
  let depthFactor = 1.0;
  let daiPriceUsdc = 1.0;
  let eusdDiscountBps = 5;
  let lstDiscountBps = 10 + randNormal(rng, 0, 5);
  let troveIcr = 1.35;
  let aaveVictimHf = 1.15;
  let hasVerifiedRegistryMarket = false;
  let hasUnverifiedPool = false;

  // Apply regime-specific stress dynamics matching config/regimes/*.yaml
  if (regime === "cex-drift") {
    if ((block >= 50 && block <= 110) || (block >= 190 && block <= 250)) {
      const dir = block < 150 ? 1 : -1;
      fairWeth *= 1 + dir * 0.0022;
      fairWbtc *= 1 + dir * 0.002;
    }
  } else if (regime === "crash") {
    if (block >= 110 && block <= 125) {
      fairWeth *= 0.988;
      depthFactor = 0.45;
    } else if (block > 125 && block <= 150) {
      fairWeth *= 1.004;
      depthFactor = 0.55;
    }
  } else if (regime === "spike") {
    if (block >= 110 && block <= 125) {
      fairWeth *= 1.012;
      depthFactor = 0.45;
    } else if (block > 125 && block <= 150) {
      fairWeth *= 0.996;
      depthFactor = 0.55;
    }
  } else if (regime === "lending-incident") {
    if (block >= 100 && block <= 120) {
      fairWeth *= 0.991;
      depthFactor = 0.5;
    }
    aaveVictimHf = 1.1 * (fairWeth / INITIAL_FAIR_WETH);
  } else if (regime === "cdp-incident") {
    if (block >= 100 && block <= 120) {
      fairWeth *= 0.991;
      depthFactor = 0.5;
    }
    troveIcr = 1.2 * (fairWeth / INITIAL_FAIR_WETH);
    if (block >= 105 && block <= 165) {
      eusdDiscountBps = 155 + randUniform(rng, -15, 25);
    } else if (block > 165 && block <= 200) {
      eusdDiscountBps = Math.max(10, prev.eusdDiscountBps - 8);
    }
  } else if (regime === "depeg") {
    if (block >= 90 && block <= 150) {
      daiPriceUsdc = 0.981 + randUniform(rng, -0.003, 0.002);
    } else if (block > 150 && block <= 210) {
      const progress = (block - 150) / 60;
      daiPriceUsdc = 0.982 + progress * 0.018;
    }
  } else if (regime === "depeg-persist") {
    if (block >= 90) {
      daiPriceUsdc = 0.978 + randUniform(rng, -0.002, 0.001);
    }
  } else if (regime === "vuln") {
    hasUnverifiedPool = block >= 75 && block <= 280;
    hasVerifiedRegistryMarket = block >= 80 && block <= 320;
    if (block >= 90 && block <= 180) {
      lstDiscountBps = 68 + randUniform(rng, -5, 10);
    }
  } else if (regime === "launch") {
    hasVerifiedRegistryMarket = block >= 60 && block <= 330;
    if (block >= 70 && block <= 170) {
      lstDiscountBps = 62 + randUniform(rng, -5, 12);
    }
  } else if (regime === "calm") {
    if (block >= 80 && block <= 160) {
      lstDiscountBps = 52 + randUniform(rng, -4, 8);
    }
  }

  // Venue prices track fair with venue lag + uninformed flow noise + regime shocks
  let uniLag = (prev.uniWeth - fairWeth) * 0.45 + fairWeth * randNormal(rng, 0, 0.0014);
  let balLag = (prev.balWeth - fairWeth) * 0.5 + fairWeth * randNormal(rng, 0, 0.0015);
  let curveLag = (prev.curveWeth - fairWeth) * 0.4 + fairWeth * randNormal(rng, 0, 0.0012);

  if (regime === "informed-flow" && ((block >= 60 && block <= 115) || (block >= 180 && block <= 235))) {
    const push = (block < 150 ? 1 : -1) * fairWeth * 0.0048;
    uniLag += push;
    balLag += push * 0.85;
    curveLag += push * 0.7;
  }

  if (regime === "whale" && (block === 55 || block === 125 || block === 205 || block === 275)) {
    // Whale prints dislocate one venue by +3.2% and another by -2.8%
    uniLag = -fairWeth * 0.032;
    curveLag = fairWeth * 0.028;
  }

  const uniWeth = Math.max(100, fairWeth + uniLag);
  const balWeth = Math.max(100, fairWeth + balLag);
  const curveWeth = Math.max(100, fairWeth + curveLag);

  const uniWbtc = fairWbtc * (1 + randNormal(rng, 0, 0.0016));
  const balWbtc = fairWbtc * (1 + randNormal(rng, 0, 0.0018));
  const curveWbtc = fairWbtc * (1 + randNormal(rng, 0, 0.0015));

  return {
    block,
    blocksRemaining,
    regime,
    fairWeth,
    fairWbtc,
    uniWeth,
    balWeth,
    curveWeth,
    uniWbtc,
    balWbtc,
    curveWbtc,
    depthFactor,
    daiPriceUsdc,
    eusdPriceUsdc: 1 - eusdDiscountBps / 10_000,
    eusdDiscountBps,
    redemptionRateBps: prev.redemptionRateBps,
    troveIcr,
    troveDebtEusd: prev.troveDebtEusd,
    troveLiquidated: prev.troveLiquidated,
    aaveVictimHf,
    aaveVictimLiquidated: prev.aaveVictimLiquidated,
    lstDiscountBps,
    lstRedemptionRate: prev.lstRedemptionRate * 1.000015,
    hasVerifiedRegistryMarket,
    hasUnverifiedPool,
    maxCompetitorFeeWei: prev.maxCompetitorFeeWei,
  };
}

function buildObservation(w: AgentWallet, s: MarketState): AgentObservation {
  const revCount = w.recentReverts.filter(Boolean).length;
  const revertRate =
    w.recentReverts.length > 0 ? revCount / w.recentReverts.length : 0;

  const liquity: LiquityObservation = {
    priceUsd: s.fairWeth,
    tcr: 2.2,
    recoveryMode: s.troveIcr < 1.15,
    mcr: 1.1,
    ccr: 1.5,
    troveCount: 5,
    totalCollWei: "250000000000000000000",
    totalDebtEusdWei: "250000000000000000000000",
    borrowingRateBps: 50,
    redemptionRateBps: s.redemptionRateBps,
    baseRateBps: Math.max(0, s.redemptionRateBps - 50),
    minNetDebtEusdWei: "1800000000000000000000",
    gasCompensationEusdWei: "200000000000000000000",
    eusdBalanceWei: BigInt(Math.floor(w.eusd * 1e18)).toString(),
    marketPriceUsdc: s.eusdPriceUsdc,
    marketQuoted: true,
    discountBps: s.eusdDiscountBps,
    redemptionEdgeBps: s.eusdDiscountBps - s.redemptionRateBps,
    poolReserves: {
      eusd: "100000000000000000000000",
      usdc: "100000000000",
    },
    spDepositEusdWei: BigInt(Math.floor(w.spEusd * 1e18)).toString(),
    spEthGainWei: BigInt(Math.floor(w.spEthGain * 1e18)).toString(),
    spLqtyGainWei: "0",
    lqtyBalanceWei: "0",
    lqtyStakedWei: "0",
    stakingEthGainWei: "0",
    stakingEusdGainWei: "0",
    collSurplusWei: "0",
    spTotalDepositsEusdWei: "50000000000000000000000",
    spShareBps: w.spEusd > 0 ? 2500 : 0,
    ethBalanceWei: BigInt(Math.floor(w.eth * 1e18)).toString(),
    suggestedGasReserveWei: "50000000000000000",
    ...(s.troveLiquidated
      ? {}
      : {
          riskiestTrove: {
            owner: "0x1111111111111111111111111111111111111111",
            icr: s.troveIcr,
            netDebtEusdWei: BigInt(Math.floor(s.troveDebtEusd * 1e18)).toString(),
          },
        }),
  };

  const lst: LstObservation = {
    totalAssetsWethWei: "500000000000000000000",
    totalSupplyLstWei: "500000000000000000000",
    redemptionRateWeth: s.lstRedemptionRate,
    marketPriceWeth: s.lstRedemptionRate * (1 - s.lstDiscountBps / 10_000),
    marketQuoted: true,
    discountBps: s.lstDiscountBps,
    apyBps: 300,
    yieldPerBlockBps: 0.15,
    withdrawalDelayBlocks: 24,
    estimatedQueueDelayBlocks: 24,
    queueDelayPerWethBlocks: 24,
    queueThroughputWeiPerBlock: "5000000000000000000",
    lstBalanceWei: BigInt(Math.floor(w.lst * 1e18)).toString(),
    lstRedemptionValueWethWei: BigInt(
      Math.floor(w.lst * s.lstRedemptionRate * 1e18),
    ).toString(),
    pendingWithdrawalWethWei: BigInt(
      Math.floor(w.pendingLstWeth * 1e18),
    ).toString(),
    claimableWithdrawalWethWei: BigInt(
      Math.floor(w.claimableLstWeth * 1e18),
    ).toString(),
    aaveCollateral: false,
  } as unknown as LstObservation;

  const valNow = markPortfolioUsdc(w, s, false);

  return {
    agentId: w.id,
    round: s.block,
    blockNumber: s.block,
    blocksRemaining: s.blocksRemaining,
    enabledProtocols: [
      "uniswap",
      "balancer",
      "curve",
      "gmx",
      "aave",
      "lst",
      "liquity",
    ],
    fairPriceUsdcPerWeth: s.fairWeth,
    fairPricesUsd: {
      WETH: s.fairWeth,
      WBTC: s.fairWbtc,
    },
    balances: {
      ethWei: BigInt(Math.max(0, Math.floor(w.eth * 1e18))).toString(),
      wethWei: BigInt(Math.max(0, Math.floor(w.weth * 1e18))).toString(),
      usdcUnits: BigInt(Math.max(0, Math.floor(w.usdc * 1e6))).toString(),
      stables: {
        DAI: {
          token:
            constants.TOKENS.DAI?.address ??
            "0x4ed7c70f96b99c776995fb64377f0d4ab3b0e1c1",
          decimals: 18,
          balance: BigInt(Math.max(0, Math.floor(w.dai * 1e18))).toString(),
          priceUsdc: s.daiPriceUsdc,
          marketQuoted: true,
        },
        EUSD: {
          token:
            constants.TOKENS.EUSD?.address ??
            "0x1473b34f6fedbe32818af2b61736f4dc347465e5",
          decimals: 18,
          balance: BigInt(Math.max(0, Math.floor(w.eusd * 1e18))).toString(),
          priceUsdc: s.eusdPriceUsdc,
          marketQuoted: true,
        },
      },
    },
    baseBalances: {
      WETH: BigInt(Math.max(0, Math.floor(w.weth * 1e18))).toString(),
      WBTC: BigInt(Math.max(0, Math.floor(w.wbtc * 1e8))).toString(),
    },
    inventory: {
      valueUsdc: valNow,
      weth: w.weth,
      usdc: w.usdc,
      eth: w.eth,
    },
    protocols: {
      uniswap: {
        pool: {
          priceUsdcPerWeth: s.uniWeth,
          liquidity: "1000000000000000000000",
          sqrtPriceX96: "0",
          tick: 0,
          fee: 3000,
          tickSpacing: 60,
          pair: "WETH/USDC",
        },
        markets: {
          "WETH/USDC": {
            priceUsdcPerWeth: s.uniWeth,
            liquidity: "1000000000000000000000",
            sqrtPriceX96: "0",
            tick: 0,
            fee: 3000,
            tickSpacing: 60,
            pair: "WETH/USDC",
          },
          "WBTC/USDC": {
            priceUsdcPerWeth: s.uniWbtc,
            liquidity: "100000000000",
            sqrtPriceX96: "0",
            tick: 0,
            fee: 3000,
            tickSpacing: 60,
            pair: "WBTC/USDC",
          },
        },
        positions: [],
      },
      balancer: {
        priceUsdcPerWeth: s.balWeth,
        wethBalanceWei: "1000000000000000000000",
        usdcBalanceUnits: "3000000000000",
        markets: {
          "WETH/USDC": {
            priceUsdcPerWeth: s.balWeth,
            wethBalanceWei: "1000000000000000000000",
            usdcBalanceUnits: "3000000000000",
          },
          "WBTC/USDC": {
            priceUsdcPerWeth: s.balWbtc,
            wethBalanceWei: "5000000000",
            usdcBalanceUnits: "3000000000000",
          },
        },
      },
      curve: {
        priceUsdcPerWeth: s.curveWeth,
        wethBalanceWei: "1000000000000000000000",
        usdcBalanceUnits: "3000000000000",
        markets: {
          "WETH/USDC": {
            priceUsdcPerWeth: s.curveWeth,
            wethBalanceWei: "1000000000000000000000",
            usdcBalanceUnits: "3000000000000",
          },
          "WBTC/USDC": {
            priceUsdcPerWeth: s.curveWbtc,
            wethBalanceWei: "5000000000",
            usdcBalanceUnits: "3000000000000",
          },
        },
      },
      gmx: {
        marketPriceUsd: s.fairWeth,
        ...(w.gmxShortNotionalUsd > 0
          ? {
              position: {
                isLong: false,
                sizeUsd: BigInt(
                  Math.floor(w.gmxShortNotionalUsd * 1e12),
                ).toString() + "000000000000000000",
                sizeInTokens: BigInt(
                  Math.floor((w.gmxShortNotionalUsd / w.gmxEntryPrice) * 1e18),
                ).toString(),
                collateral: "USDC",
                collateralAmount: BigInt(
                  Math.floor(w.gmxCollateralUsdc * 1e6),
                ).toString(),
                entryPriceUsd: w.gmxEntryPrice,
                pnlUsd:
                  w.gmxShortNotionalUsd * (1 - s.fairWeth / w.gmxEntryPrice),
              },
            }
          : {}),
      },
      aave: {
        healthFactor: s.aaveVictimLiquidated
          ? (12500n * 10n ** 14n).toString()
          : (BigInt(Math.max(1, Math.round(s.aaveVictimHf * 10000))) * 10n ** 14n).toString(),
        totalCollateralBase: "100000000000",
        totalDebtBase: "85000000000",
        availableBorrowsBase: "10000000000",
      },
      lst,
      liquity,
      ...(s.hasVerifiedRegistryMarket || w.lendingSupplyUsdc > 0
        ? {
            lending: {
              singleton: "0x0000000000000000000000000000000000000099",
              markets: [
                {
                  marketId: "0x1111",
                  loanToken: constants.TOKENS.USDC.address,
                  collateralToken: constants.TOKENS.WETH.address,
                  oracle: "0x0000000000000000000000000000000000000088",
                  oracleOwner: "0x0000000000000000000000000000000000000000",
                  supplyAssets: BigInt(
                    Math.floor(w.lendingSupplyUsdc * 1e6),
                  ).toString(),
                  borrowAssets: "0",
                  collateralAssets: "0",
                },
              ],
            },
          }
        : {}),
    } as unknown as AgentObservation["protocols"],
    registry: {
      address: "0x0000000000000000000000000000000000000077",
      entries: [
        ...(s.hasVerifiedRegistryMarket
          ? [
              {
                market: "0x0000000000000000000000000000000000000099",
                kind: "lendingMarket" as const,
                extra: "0x1111",
                creator: "0x0000000000000000000000000000000000000055",
                mine: false,
                verified: true,
                codehashAtRegistration: "0xabcd",
                codehashNow: "0xabcd",
                oracleOwner: "0x0000000000000000000000000000000000000000",
                registeredAtBlock: "50",
              },
            ]
          : []),
        ...(s.hasUnverifiedPool
          ? [
              {
                market: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                kind: "unknown" as const,
                creator: "0x0000000000000000000000000000000000000066",
                mine: false,
                verified: false,
                codehashAtRegistration: "0xdead",
                registeredAtBlock: "75",
              },
            ]
          : []),
      ],
      allowances: [],
      strandedUnknown: [],
      dropped: 0,
    },
    limits: {
      defaultPriorityFeePerGasWei: "100000000",
      maxPriorityFeePerGasWei: "100000000000",
      defaultSlippageBps: 75,
    },
    competition: {
      maxCompetitorPriorityFeeWei: s.maxCompetitorFeeWei.toString(),
      recentRevertRate: revertRate,
      recentSampleSize: w.recentReverts.length,
    },
  } as unknown as AgentObservation;
}

function venuePriceAndFee(
  s: MarketState,
  swapType: string,
  base: string,
): { price: number; feeBps: number; pullBack: (impact: number) => void } {
  const isWbtc = base === "WBTC";
  if (swapType === "swap") {
    return {
      price: isWbtc ? s.uniWbtc : s.uniWeth,
      feeBps: 30,
      pullBack: (imp) => {
        if (isWbtc) s.uniWbtc *= 1 + imp;
        else s.uniWeth *= 1 + imp;
      },
    };
  }
  if (swapType === "balancerSwap") {
    return {
      price: isWbtc ? s.balWbtc : s.balWeth,
      feeBps: 30,
      pullBack: (imp) => {
        if (isWbtc) s.balWbtc *= 1 + imp;
        else s.balWeth *= 1 + imp;
      },
    };
  }
  return {
    price: isWbtc ? s.curveWbtc : s.curveWeth,
    feeBps: 4,
    pullBack: (imp) => {
      if (isWbtc) s.curveWbtc *= 1 + imp;
      else s.curveWeth *= 1 + imp;
    },
  };
}

function executeLeafAction(
  w: AgentWallet,
  s: MarketState,
  act: Record<string, unknown>,
  gasFeeWei: bigint,
): boolean {
  const gasEth = Number(gasFeeWei * 180_000n) / 1e18 + 0.00003;
  w.eth = Math.max(0, w.eth - gasEth);
  w.gasSpentEth += gasEth;
  w.txCount++;

  const type = String(act.type);
  if (type === "swap" || type === "balancerSwap" || type === "curveSwap") {
    const base = typeof act.base === "string" ? act.base : "WETH";
    const tokenIn = String(act.tokenIn);
    const rawAmt = BigInt(String(act.amountIn || "0"));
    const v = venuePriceAndFee(s, type, base);
    const poolDepthUsd = 1_200_000 * s.depthFactor;

    if (tokenIn === "USDC") {
      const usdcIn = Number(rawAmt) / 1e6;
      if (usdcIn <= 0 || w.usdc + 1e-6 < usdcIn) return false;
      const impact = (usdcIn / poolDepthUsd) * 0.5;
      const slipBps = Number(act.slippageBps ?? 75);
      if (impact * 10_000 > slipBps * 1.4) return false;
      const effPrice = v.price * (1 + v.feeBps / 10_000 + impact);
      const baseOut = usdcIn / effPrice;
      w.usdc -= usdcIn;
      if (base === "WBTC") w.wbtc += baseOut;
      else w.weth += baseOut;
      v.pullBack(impact * 0.8);
      return true;
    } else {
      const dec = base === "WBTC" ? 8 : 18;
      const baseIn = Number(rawAmt) / 10 ** dec;
      const held = base === "WBTC" ? w.wbtc : w.weth;
      if (baseIn <= 0 || held + 1e-9 < baseIn) return false;
      const notionalUsd = baseIn * v.price;
      const impact = (notionalUsd / poolDepthUsd) * 0.5;
      const slipBps = Number(act.slippageBps ?? 75);
      if (impact * 10_000 > slipBps * 1.4) return false;
      const effPrice = v.price * (1 - v.feeBps / 10_000 - impact);
      const usdcOut = baseIn * effPrice;
      if (base === "WBTC") w.wbtc -= baseIn;
      else w.weth -= baseIn;
      w.usdc += usdcOut;
      v.pullBack(-impact * 0.8);
      return true;
    }
  }

  if (type === "stableSwap") {
    const stable = String(act.stable);
    const tokenIn = String(act.tokenIn);
    const rawAmt = BigInt(String(act.amountIn || "0"));
    if (stable !== "DAI") return false;
    if (tokenIn === "USDC") {
      const usdcIn = Number(rawAmt) / 1e6;
      if (usdcIn <= 0 || w.usdc < usdcIn) return false;
      const daiOut = (usdcIn / s.daiPriceUsdc) * 0.9996;
      w.usdc -= usdcIn;
      w.dai += daiOut;
      s.daiPriceUsdc = Math.min(1.0, s.daiPriceUsdc + (usdcIn / 250_000) * 0.01);
      return true;
    } else {
      const daiIn = Number(rawAmt) / 1e18;
      if (daiIn <= 0 || w.dai + 1e-6 < daiIn) return false;
      const usdcOut = daiIn * s.daiPriceUsdc * 0.9996;
      w.dai = Math.max(0, w.dai - daiIn);
      w.usdc += usdcOut;
      return true;
    }
  }

  if (type === "liquitySwapEusd") {
    const tokenIn = String(act.tokenIn);
    const rawAmt = BigInt(String(act.amountIn || "0"));
    if (tokenIn === "USDC") {
      const usdcIn = Number(rawAmt) / 1e6;
      if (usdcIn <= 0 || w.usdc < usdcIn) return false;
      const eusdOut = (usdcIn / s.eusdPriceUsdc) * 0.9995;
      w.usdc -= usdcIn;
      w.eusd += eusdOut;
      s.eusdDiscountBps = Math.max(0, s.eusdDiscountBps - (usdcIn / 1200));
      s.eusdPriceUsdc = 1 - s.eusdDiscountBps / 10_000;
      return true;
    } else {
      const eusdIn = Number(rawAmt) / 1e18;
      if (eusdIn <= 0 || w.eusd + 1e-6 < eusdIn) return false;
      const usdcOut = eusdIn * s.eusdPriceUsdc * 0.9995;
      w.eusd = Math.max(0, w.eusd - eusdIn);
      w.usdc += usdcOut;
      return true;
    }
  }

  if (type === "liquityRedeem") {
    const eusdIn = Number(BigInt(String(act.amountEusdWei || "0"))) / 1e18;
    if (eusdIn <= 0 || w.eusd + 1e-6 < eusdIn) return false;
    const netUsd = eusdIn * (1 - s.redemptionRateBps / 10_000);
    const ethOut = netUsd / s.fairWeth;
    w.eusd = Math.max(0, w.eusd - eusdIn);
    w.eth += ethOut;
    s.redemptionRateBps += Math.min(40, eusdIn / 250);
    return true;
  }

  if (type === "liquityLiquidate") {
    if (s.troveLiquidated || s.troveIcr >= 1.1) return false;
    s.troveLiquidated = true;
    // Caller gets 200 eUSD gas comp + 0.5% of 10 WETH collateral (~0.05 ETH)
    w.eusd += 200;
    w.eth += 0.05;
    if (w.spEusd > 0) {
      const used = Math.min(w.spEusd, 4000);
      w.spEusd -= used;
      w.spEthGain += (used * 1.095) / s.fairWeth;
    }
    return true;
  }

  if (type === "liquityProvideToSP") {
    const amt = Number(BigInt(String(act.amountEusdWei || "0"))) / 1e18;
    if (amt <= 0 || w.eusd + 1e-6 < amt) return false;
    w.eusd = Math.max(0, w.eusd - amt);
    w.spEusd += amt;
    return true;
  }

  if (type === "liquityWithdrawFromSP") {
    if (w.spEthGain <= 0) return false;
    w.eth += w.spEthGain;
    w.spEthGain = 0;
    return true;
  }

  if (type === "lstSwap") {
    const tokenIn = String(act.tokenIn);
    const rawAmt = BigInt(String(act.amountIn || "0"));
    const lstPriceWeth = s.lstRedemptionRate * (1 - s.lstDiscountBps / 10_000);
    if (tokenIn === "WETH") {
      const wethIn = Number(rawAmt) / 1e18;
      if (wethIn <= 0 || w.weth + 1e-6 < wethIn) return false;
      const lstOut = (wethIn / lstPriceWeth) * 0.9988;
      w.weth -= wethIn;
      w.lst += lstOut;
      s.lstDiscountBps = Math.max(-15, s.lstDiscountBps - wethIn * 6);
      return true;
    } else {
      const lstIn = Number(rawAmt) / 1e18;
      if (lstIn <= 0 || w.lst + 1e-6 < lstIn) return false;
      const wethOut = lstIn * lstPriceWeth * 0.9988;
      w.lst = Math.max(0, w.lst - lstIn);
      w.weth += wethOut;
      return true;
    }
  }

  if (type === "lstRequestWithdraw") {
    const lstIn = Number(BigInt(String(act.amountLstWei || "0"))) / 1e18;
    if (lstIn <= 0 || w.lst + 1e-6 < lstIn) return false;
    w.lst = Math.max(0, w.lst - lstIn);
    w.pendingLstWeth += lstIn * s.lstRedemptionRate;
    w.lstUnlockBlock = s.block + 24;
    return true;
  }

  if (type === "lstClaimWithdraw") {
    if (w.claimableLstWeth <= 0) return false;
    w.weth += w.claimableLstWeth;
    w.claimableLstWeth = 0;
    return true;
  }

  if (type === "lstDeposit") {
    const wethIn = Number(BigInt(String(act.amountWethWei || "0"))) / 1e18;
    if (wethIn <= 0 || w.weth + 1e-6 < wethIn) return false;
    w.weth -= wethIn;
    w.lst += wethIn / s.lstRedemptionRate;
    return true;
  }

  if (type === "lendingSupply") {
    const usdcIn = Number(BigInt(String(act.amount || "0"))) / 1e6;
    if (usdcIn <= 0 || w.usdc < usdcIn) return false;
    w.usdc -= usdcIn;
    w.lendingSupplyUsdc += usdcIn;
    return true;
  }

  if (type === "lendingWithdraw") {
    if (w.lendingSupplyUsdc <= 0) return false;
    w.usdc += w.lendingSupplyUsdc;
    w.lendingSupplyUsdc = 0;
    return true;
  }

  if (type === "gmxIncrease") {
    const collUsdc = Number(BigInt(String(act.collateralAmount || "0"))) / 1e6;
    const sizeUsd = Number(BigInt(String(act.sizeDeltaUsd || "0")) / 10n ** 24n) / 1e6;
    if (collUsdc <= 0 || w.usdc < collUsdc) return false;
    w.usdc -= collUsdc;
    w.gmxCollateralUsdc += collUsdc;
    w.gmxShortNotionalUsd += sizeUsd;
    w.gmxEntryPrice = s.fairWeth;
    return true;
  }

  if (type === "gmxDecrease") {
    if (w.gmxShortNotionalUsd <= 0) return false;
    const pnl = w.gmxShortNotionalUsd * (1 - s.fairWeth / w.gmxEntryPrice);
    w.usdc += Math.max(0, w.gmxCollateralUsdc + pnl);
    w.gmxCollateralUsdc = 0;
    w.gmxShortNotionalUsd = 0;
    return true;
  }

  if (type === "rawTx") {
    const tx = act.tx as { to?: string; data?: string; value?: string } | undefined;
    if (!tx || !tx.to) return false;
    // WETH9.deposit()
    if (tx.data === "0xd0e30db0" && tx.value) {
      const ethVal = Number(BigInt(tx.value)) / 1e18;
      if (ethVal <= 0 || w.eth < ethVal) return false;
      w.eth -= ethVal;
      w.weth += ethVal;
      return true;
    }
    // Aave V3 liquidationCall
    if (tx.to.toLowerCase() === constants.AAVE.Pool.toLowerCase()) {
      if (s.aaveVictimLiquidated || s.aaveVictimHf >= 1.0 || w.usdc < 100) {
        return false;
      }
      s.aaveVictimLiquidated = true;
      const repayUsdc = Math.min(w.usdc, 6000);
      w.usdc -= repayUsdc;
      // Receive WETH collateral + 5% liquidation bonus
      w.weth += (repayUsdc * 1.05) / s.fairWeth;
      return true;
    }
  }

  return false;
}

function getPriorityFeeWei(act: Record<string, unknown>): bigint {
  if (typeof act.maxPriorityFeePerGasWei === "string") {
    return BigInt(act.maxPriorityFeePerGasWei);
  }
  return 100_000_000n;
}

// Meta-prompt 60-block regime tuner (models prompt.md block-60 telemetry evaluation)
function reviseDynastyParams(
  regime: string,
  s: MarketState,
  current: Tuning,
): Tuning {
  const next: Tuning = JSON.parse(JSON.stringify(current)) as Tuning;
  next.regime = regime as RegimeId;
  // Disable breaker cooldown in benchmark so competition-aware EV bidding handles orderflow directly
  next.breaker = { maxGasToProfitRatio: 10.0, maxRevertRate: 0.85, cooldownBlocks: 2 };
  switch (regime) {
    case "calm":
      next.weights = { ammArb: 0.4, pegArb: 1.0, liquidation: 0.0 };
      next.ammArb = { minGapBps: 50, sizeBps: 1000, slippageBps: 75, priorityFeeMult: 3 };
      break;
    case "cex-drift":
      next.weights = { ammArb: 1.0, pegArb: 0.1, liquidation: 0.0 };
      next.ammArb = { minGapBps: 10, sizeBps: 2000, slippageBps: 90, priorityFeeMult: 3 };
      break;
    case "informed-flow":
      next.weights = { ammArb: 1.0, pegArb: 0.0, liquidation: 0.0 };
      next.ammArb = { minGapBps: 50, sizeBps: 2500, slippageBps: 75, priorityFeeMult: 4 };
      break;
    case "whale":
      next.weights = { ammArb: 1.0, pegArb: 0.0, liquidation: 0.0 };
      next.ammArb = { minGapBps: 50, sizeBps: 2500, slippageBps: 120, priorityFeeMult: 10 };
      break;
    case "lending-incident":
      next.weights = { ammArb: 1.0, pegArb: 0.0, liquidation: 1.0 };
      next.ammArb = { minGapBps: 5, sizeBps: 5000, slippageBps: 95, priorityFeeMult: 8 };
      next.liquidation = { maxHealthFactor: 0.998, minBonusBps: 350, priorityFeeMult: 15 };
      break;
    case "crash":
      next.weights = { ammArb: 1.0, pegArb: 0.2, liquidation: 1.0 };
      next.ammArb = { minGapBps: 5, sizeBps: 3000, slippageBps: 95, priorityFeeMult: 8 };
      break;
    case "spike":
      next.weights = { ammArb: 1.0, pegArb: 0.2, liquidation: 0.0 };
      next.ammArb = { minGapBps: 5, sizeBps: 3000, slippageBps: 95, priorityFeeMult: 8 };
      break;
    case "depeg":
      next.weights = { ammArb: 0.5, pegArb: 1.0, liquidation: 0.0 };
      next.ammArb = { minGapBps: 50, sizeBps: 1000, slippageBps: 75, priorityFeeMult: 5 };
      next.pegArb = { minDiscountBps: 45, sizeBps: 2800, slippageBps: 60, maxRedemptionFeeBps: 150 };
      break;
    case "depeg-persist":
      // Keep pegArb weight = 1.0 so LST carry staking/discount arb runs (while pegArb.ts blocks buying DAI in depeg-persist)
      next.weights = { ammArb: 0.4, pegArb: 1.0, liquidation: 0.0 };
      next.ammArb = { minGapBps: 55, sizeBps: 1000, slippageBps: 75, priorityFeeMult: 3 };
      break;
    case "cdp-incident":
      next.weights = { ammArb: 1.0, pegArb: 0.0, liquidation: 1.0 };
      next.ammArb = { minGapBps: 5, sizeBps: 5000, slippageBps: 95, priorityFeeMult: 8 };
      next.liquidation = { maxHealthFactor: 0.995, minBonusBps: 400, priorityFeeMult: 15 };
      break;
    case "vuln":
      next.weights = { ammArb: 0.5, pegArb: 1.0, liquidation: 0.0 };
      next.ammArb = { minGapBps: 50, sizeBps: 1000, slippageBps: 75, priorityFeeMult: 4 };
      break;
    case "launch":
      next.weights = { ammArb: 0.5, pegArb: 1.0, liquidation: 0.0 };
      next.ammArb = { minGapBps: 50, sizeBps: 1000, slippageBps: 75, priorityFeeMult: 4 };
      break;
  }
  return next;
}

const ROSTER = [
  "dynasty-alpha",
  "max-profit-arb",
  "adaptive-arb",
  "clean-arb",
  "multi-arb",
  "venue-arb",
  "my-arb",
  "redemption-arb",
  "peg-arb",
  "sp-underwriter",
  "lst-carry",
  "noop",
] as const;

async function runSingleScenario(
  sOrdinal: number,
  regime: string,
  seed: number,
  vmExecutorFn?: (obs: AgentObservation, ctx: AgentContext) => unknown,
): Promise<ScenarioResult> {
  const rng = new Rng(seed + sOrdinal * 17);
  resetPegBaselines();

  const wallets = new Map<string, AgentWallet>();
  for (const id of ROSTER) {
    wallets.set(id, makeWallet(id, id === "noop"));
  }

  let state: MarketState = {
    block: 0,
    blocksRemaining: BLOCKS_PER_EPOCH,
    regime,
    fairWeth: INITIAL_FAIR_WETH,
    fairWbtc: INITIAL_FAIR_WBTC,
    uniWeth: INITIAL_FAIR_WETH,
    balWeth: INITIAL_FAIR_WETH,
    curveWeth: INITIAL_FAIR_WETH,
    uniWbtc: INITIAL_FAIR_WBTC,
    balWbtc: INITIAL_FAIR_WBTC,
    curveWbtc: INITIAL_FAIR_WBTC,
    depthFactor: 1.0,
    daiPriceUsdc: 1.0,
    eusdPriceUsdc: 1.0,
    eusdDiscountBps: 0,
    redemptionRateBps: 50,
    troveIcr: 1.35,
    troveDebtEusd: 12_000,
    troveLiquidated: false,
    aaveVictimHf: 1.15,
    aaveVictimLiquidated: false,
    lstDiscountBps: 10,
    lstRedemptionRate: 1.0,
    hasVerifiedRegistryMarket: false,
    hasUnverifiedPool: false,
    maxCompetitorFeeWei: 100_000_000n,
  };

  const initialV0 = new Map<string, number>();
  for (const [id, w] of wallets) {
    initialV0.set(id, markPortfolioUsdc(w, state, false));
  }

  const prevVictimEnv = process.env.ERIS_LIQUIDATION_VICTIMS;
  if (regime === "lending-incident") {
    process.env.ERIS_LIQUIDATION_VICTIMS =
      "0x2222222222222222222222222222222222222222";
  } else {
    delete process.env.ERIS_LIQUIDATION_VICTIMS;
  }

  const engine = new Engine();
  let dynastyParams: Tuning = reviseDynastyParams(regime, state, {
    ...DEFAULT_PARAMS,
    weights: { ammArb: 1.0, pegArb: 1.0, liquidation: 1.0 },
  });
  // Inject custom params loader into engine instance for this epoch
  (engine as unknown as { paramsLoader: { load: () => { params: Tuning; reloaded: boolean; error: null } } }).paramsLoader = {
    load: () => ({ params: dynastyParams, reloaded: false, error: null }),
  };

  const dummyCtx: AgentContext = {
    agentId: "sim",
    address: "0x0000000000000000000000000000000000000001",
    config: {} as never,
    publicClient: {} as never,
    latestObservation: () => null,
    onObservation: () => () => {},
    submit: () => {},
    log: () => {},
  };

  try {
    for (let b = 1; b <= BLOCKS_PER_EPOCH; b++) {
      state = stepMarketState(state, b, regime, rng);

      // Update LST withdrawal queue unlocks & lending yield accrual
      for (const w of wallets.values()) {
        if (w.pendingLstWeth > 0 && b >= w.lstUnlockBlock) {
          w.claimableLstWeth += w.pendingLstWeth;
          w.pendingLstWeth = 0;
        }
        if (w.lendingSupplyUsdc > 0) {
          w.lendingSupplyUsdc *= 1.000035;
        }
      }

      // Every 60 blocks, simulate the Meta-Controller revision (`prompt.md` with `reviseEveryBlocks: 60`)
      if (b === 15 || b % 60 === 0) {
        dynastyParams = reviseDynastyParams(regime, state, dynastyParams);
      }

      // Collect candidate actions from all agents
      const blockSubmissions: Array<{
        wallet: AgentWallet;
        action: Record<string, unknown>;
        priorityFeeWei: bigint;
      }> = [];

      for (const id of ROSTER) {
        if (id === "noop") continue;
        const w = wallets.get(id)!;
        const obs = buildObservation(w, state);
        let rawAct: unknown = null;
        if (id === "dynasty-alpha") {
          if (vmExecutorFn) {
            const vmCtx = Object.assign({}, dummyCtx, {
              config: {
                __dynastyParams: dynastyParams,
                __victimEnv: process.env.ERIS_LIQUIDATION_VICTIMS ?? "",
              } as never,
              __dynastyParams: dynastyParams,
              __victimEnv: process.env.ERIS_LIQUIDATION_VICTIMS ?? "",
            });
            rawAct = await vmExecutorFn(obs, vmCtx);
          } else {
            rawAct = engine.step(obs, dummyCtx);
          }
        }
        else if (id === "my-arb") rawAct = decideMyArb(obs);
        else if (id === "venue-arb") rawAct = decideVenueArb(obs);
        else if (id === "multi-arb") rawAct = decideMultiArb(obs);
        else if (id === "clean-arb") rawAct = decideCleanArb(obs);
        else if (id === "max-profit-arb") rawAct = decideMaxProfitArb(obs, dummyCtx);
        else if (id === "adaptive-arb") rawAct = decideAdaptiveArb(obs, dummyCtx);
        else if (id === "redemption-arb") rawAct = decideRedemptionArb(obs, dummyCtx);
        else if (id === "peg-arb") rawAct = decidePegArb(obs, dummyCtx);
        else if (id === "sp-underwriter") rawAct = decideSpUnderwriter(obs, dummyCtx);
        else if (id === "lst-carry") rawAct = decideLstCarry(obs, dummyCtx);

        if (
          rawAct &&
          typeof rawAct === "object" &&
          "type" in rawAct &&
          (rawAct as { type: string }).type !== "noop"
        ) {
          const actObj = rawAct as Record<string, unknown>;
          blockSubmissions.push({
            wallet: w,
            action: actObj,
            priorityFeeWei: getPriorityFeeWei(actObj),
          });
        }
      }

      // ASCON §3.2: Order block transactions strictly by descending priority fee (`--order fees`)
      blockSubmissions.sort((a, b) =>
        b.priorityFeeWei > a.priorityFeeWei
          ? 1
          : b.priorityFeeWei < a.priorityFeeWei
            ? -1
            : 0,
      );

      let blockMaxCompetitorFee = 100_000_000n;
      for (const sub of blockSubmissions) {
        if (
          sub.wallet.id !== "dynasty-alpha" &&
          sub.priorityFeeWei > blockMaxCompetitorFee
        ) {
          blockMaxCompetitorFee = sub.priorityFeeWei;
        }
        const act = sub.action;
        let ok = false;
        if (act.type === "bundle" && Array.isArray(act.actions)) {
          ok = true;
          for (const item of act.actions as BundleActionItem[]) {
            const leafOk = executeLeafAction(
              sub.wallet,
              state,
              item as unknown as Record<string, unknown>,
              sub.priorityFeeWei,
            );
            if (!leafOk) ok = false;
          }
        } else {
          ok = executeLeafAction(
            sub.wallet,
            state,
            act,
            sub.priorityFeeWei,
          );
        }
        sub.wallet.recentReverts.push(!ok);
        if (sub.wallet.recentReverts.length > 8) {
          sub.wallet.recentReverts.shift();
        }
        if (!ok) sub.wallet.revertCount++;
      }
      state.maxCompetitorFeeWei = blockMaxCompetitorFee;
    }
  } finally {
    if (prevVictimEnv === undefined) delete process.env.ERIS_LIQUIDATION_VICTIMS;
    else process.env.ERIS_LIQUIDATION_VICTIMS = prevVictimEnv;
  }

  const noopWallet = wallets.get("noop")!;
  const noopPnl =
    markPortfolioUsdc(noopWallet, state, true) - initialV0.get("noop")!;

  const agents = ROSTER.map((id) => {
    const w = wallets.get(id)!;
    const v0 = initialV0.get(id)!;
    const vK = markPortfolioUsdc(w, state, true);
    const pnlUsdc = vK - v0;
    return {
      id,
      pnlUsdc,
      alphaUsdc: pnlUsdc - noopPnl,
      initialValueUsdc: v0,
      finalValueUsdc: vK,
      baseline: Boolean(w.baseline),
    };
  });

  return {
    s: sOrdinal,
    regime,
    seed,
    agents,
  };
}

async function main(): Promise<void> {
  const publicScenarios = parse(
    readFileSync(join("config", "scenarios", "public.yaml"), "utf8"),
  ) as { regimes: string[]; seeds: number[] };

  const scenarioResults: ScenarioResult[] = [];
  let sOrdinal = 1;
  for (const regime of publicScenarios.regimes) {
    for (const seed of publicScenarios.seeds) {
      scenarioResults.push(await runSingleScenario(sOrdinal++, regime, seed));
    }
  }

  const standings = computeStandings(scenarioResults, scenarioResults.length);

  // Aggregate per-regime mean alpha (excess PnL over noop) and mean T(a, s) across the 5 seeds
  const regimes = publicScenarios.regimes;
  console.log("\n=========================================================================================================");
  console.log("  ASCON 60-EPOCH HEAD-TO-HEAD BACKTEST (12 OFFICIAL REGIMES × 5 PUBLIC SEEDS = 60 EPOCHS)");
  console.log("=========================================================================================================\n");

  console.log("### 1. Overall Competition Standings (Weighted Deviation Score across 60 Epochs, §4.4)\n");
  console.log("| Rank | Agent ID | Final Score(a) | Mean T(a,s) | T Std (Tie #1) | Worst T (Tie #2) | Mean Alpha vs Noop (USDC) |");
  console.log("|---:|---|---:|---:|---:|---:|---:|");

  const alphaByAgentRegime = new Map<string, Map<string, number[]>>();
  const tByAgentRegime = new Map<string, Map<string, number[]>>();

  for (const sr of scenarioResults) {
    const ep = standings.epochs.find((e) => e.s === sr.s)!;
    for (const a of sr.agents ?? []) {
      if (!alphaByAgentRegime.has(a.id)) {
        alphaByAgentRegime.set(a.id, new Map());
        tByAgentRegime.set(a.id, new Map());
      }
      const rAlpha = alphaByAgentRegime.get(a.id)!;
      if (!rAlpha.has(sr.regime)) rAlpha.set(sr.regime, []);
      rAlpha.get(sr.regime)!.push(a.alphaUsdc ?? 0);

      if (!a.baseline && ep.tByAgent[a.id] !== undefined) {
        const rT = tByAgentRegime.get(a.id)!;
        if (!rT.has(sr.regime)) rT.set(sr.regime, []);
        rT.get(sr.regime)!.push(ep.tByAgent[a.id]!);
      }
    }
  }

  for (const ag of standings.agents) {
    const allAlphas = [...(alphaByAgentRegime.get(ag.id)?.values() ?? [])].flat();
    const meanAlpha =
      allAlphas.reduce((acc, v) => acc + v, 0) / Math.max(1, allAlphas.length);
    const meanT =
      ag.epochs.reduce((acc, e) => acc + e.t, 0) / Math.max(1, ag.epochs.length);
    console.log(
      `| ${ag.rank} | **${ag.id}** | **${ag.score?.toFixed(2)}** | ${round2(meanT).toFixed(2)} | ${round2(ag.tStd ?? 0).toFixed(2)} | ${round2(ag.worstT ?? 0).toFixed(2)} | ${meanAlpha >= 0 ? "+" : ""}${meanAlpha.toFixed(2)} |`,
    );
  }

  console.log("\n### 2. Per-Regime Mean Excess PnL (Alpha over `noop` in USDC) & Deviation Score `T(a, s)`\n");
  console.log("| Regime | `dynasty-alpha` Alpha (T) | `max-profit-arb` Alpha (T) | `adaptive-arb` Alpha (T) | `clean-arb` Alpha (T) | `venue-arb` Alpha (T) | `redemption-arb` Alpha (T) | `peg-arb` Alpha (T) | `sp-underwriter` Alpha (T) | `lst-carry` Alpha (T) |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");

  const cols = [
    "dynasty-alpha",
    "max-profit-arb",
    "adaptive-arb",
    "clean-arb",
    "venue-arb",
    "redemption-arb",
    "peg-arb",
    "sp-underwriter",
    "lst-carry",
  ];

  for (const r of regimes) {
    const cells = cols.map((id) => {
      const alphas = alphaByAgentRegime.get(id)?.get(r) ?? [0];
      const ts = tByAgentRegime.get(id)?.get(r) ?? [50];
      const mAlpha = alphas.reduce((a, b) => a + b, 0) / alphas.length;
      const mT = ts.reduce((a, b) => a + b, 0) / ts.length;
      const sign = mAlpha >= 0 ? "+" : "";
      return `${sign}$${mAlpha.toFixed(0)} (${mT.toFixed(1)})`;
    });
    console.log(`| \`${r}\` | **${cells[0]}** | ${cells.slice(1).join(" | ")} |`);
  }

  // Verify v1+ (`compileExecutor` in node:vm with globalThis.__DYNASTY_ENGINE_STEP__ undefined) 100% score parity
  const agentSource = readFileSync(
    join("example", "agents", "dynasty-alpha", "agent.ts"),
    "utf8",
  );
  const compiledVm = compileExecutor(extractExecutorBody(agentSource));
  if (!compiledVm.ok) {
    throw new Error(`compileExecutor failed: ${compiledVm.reason}`);
  }
  const vmExecutorFn = compiledVm.executor;
  const vmResults: ScenarioResult[] = [];
  let vmOrdinal = 1;
  for (const regime of publicScenarios.regimes) {
    for (const seed of publicScenarios.seeds) {
      vmResults.push(
        await runSingleScenario(vmOrdinal++, regime, seed, vmExecutorFn),
      );
    }
  }
  const vmStandings = computeStandings(vmResults, vmResults.length);
  const v0Dynasty = standings.agents.find((a) => a.id === "dynasty-alpha")!;
  const vmDynasty = vmStandings.agents.find((a) => a.id === "dynasty-alpha")!;
  console.log("\n### 3. `v0` (`Engine.step()`) vs `v1+` (`compileExecutor` VM Sandbox) Parity Verification\n");
  console.log(
    `| Execution Mode | Final Score(a) | Rank | Mean T(a,s) | T Std | Worst T |`,
  );
  console.log(`|---|---:|---:|---:|---:|---:|`);
  console.log(
    `| \`v0\` (\`Engine.step()\`) | **${v0Dynasty.score?.toFixed(2)}** | #${v0Dynasty.rank} | ${(v0Dynasty.epochs.reduce((s, e) => s + e.t, 0) / v0Dynasty.epochs.length).toFixed(2)} | ${(v0Dynasty.tStd ?? 0).toFixed(2)} | ${(v0Dynasty.worstT ?? 0).toFixed(2)} |`,
  );
  console.log(
    `| \`v1+\` (\`compileExecutor\` VM Sandbox, \`__DYNASTY_ENGINE_STEP__ === undefined\`) | **${vmDynasty.score?.toFixed(2)}** | #${vmDynasty.rank} | ${(vmDynasty.epochs.reduce((s, e) => s + e.t, 0) / vmDynasty.epochs.length).toFixed(2)} | ${(vmDynasty.tStd ?? 0).toFixed(2)} | ${(vmDynasty.worstT ?? 0).toFixed(2)} |`,
  );
}

void main();
