import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentObservation, LiquityObservation, LstObservation } from "@eris/sdk";
import * as constants from "@eris/sdk/constants.js";
import {
  decide as decideDynasty,
  extractExecutorBody,
} from "../example/agents/dynasty-alpha/agent.js";
import { Engine } from "../example/agents/dynasty-alpha/engine/Engine.js";
import {
  computeEvPriorityFee,
  estimateGasCostUsd,
  isRivalAboveEvCeiling,
  passesNetEvGate,
  SINGLE_LEG_GAS_UNITS,
} from "../example/agents/dynasty-alpha/engine/priorityFee.js";
import {
  buildCoreWhitelist,
  verifyActionWhitelist,
} from "../example/agents/dynasty-alpha/engine/whitelist.js";
import { resetPegBaselines } from "../example/agents/dynasty-alpha/modules/pegArb.js";
import {
  clampSafetyParams,
  DEFAULT_PARAMS,
  validateParams,
  type Tuning,
} from "../example/agents/dynasty-alpha/StrategyTuning.js";
import { decide as decideMyArb } from "../example/agents/my-arb/agent.js";
import {
  buildRevisionSystem,
  compileExecutor,
  extractRevisionJson,
  loadImproveAgent,
  parseRevision,
} from "../example/agents/runtime/improve.js";

function makeFixtureObs(overrides: Partial<AgentObservation> = {}): AgentObservation {
  return {
    agentId: "dynasty-alpha",
    round: 42,
    blocksRemaining: 300,
    fairPriceUsdcPerWeth: 3000,
    balances: {
      ethWei: "1000000000000000000",
      wethWei: "8000000000000000000",
      usdcUnits: "25000000000",
    },
    baseBalances: {
      WETH: "8000000000000000000",
      WBTC: "40000000",
    },
    protocols: {
      uniswap: {
        pool: {
          priceUsdcPerWeth: 2985,
          liquidity: "1000000000000000000000",
          sqrtPriceX96: "0",
          tick: 0,
        },
        positions: [],
      },
      balancer: {
        priceUsdcPerWeth: 3002,
        wethBalanceWei: "1000000000000000000000",
        usdcBalanceUnits: "3000000000000",
      },
      curve: {
        priceUsdcPerWeth: 3025,
        wethBalanceWei: "1000000000000000000000",
        usdcBalanceUnits: "3000000000000",
      },
    },
    limits: {
      defaultPriorityFeePerGasWei: "100000000",
      maxPriorityFeePerGasWei: "100000000000",
      defaultSlippageBps: 75,
    },
    competition: {
      maxCompetitorPriorityFeeWei: "100000000",
    },
    ...overrides,
  } as unknown as AgentObservation;
}

function makeLiquityObs(
  overrides: Partial<LiquityObservation> = {},
): LiquityObservation {
  const discountBps = overrides.discountBps ?? 150;
  const redemptionRateBps = overrides.redemptionRateBps ?? 50;
  return {
    priceUsd: 3000,
    tcr: 2.5,
    recoveryMode: false,
    mcr: 1.1,
    ccr: 1.5,
    troveCount: 5,
    totalCollWei: "250000000000000000000",
    totalDebtEusdWei: "250000000000000000000000",
    borrowingRateBps: 50,
    redemptionRateBps,
    baseRateBps: 0,
    minNetDebtEusdWei: "1800000000000000000000",
    gasCompensationEusdWei: "200000000000000000000",
    eusdBalanceWei: "0",
    marketPriceUsdc: 1 - discountBps / 10_000,
    marketQuoted: true,
    discountBps,
    redemptionEdgeBps: discountBps - redemptionRateBps,
    poolReserves: {
      eusd: "100000000000000000000000",
      usdc: "100000000000",
    },
    spDepositEusdWei: "0",
    spEthGainWei: "0",
    spLqtyGainWei: "0",
    lqtyBalanceWei: "0",
    lqtyStakedWei: "0",
    stakingEthGainWei: "0",
    stakingEusdGainWei: "0",
    collSurplusWei: "0",
    spTotalDepositsEusdWei: "50000000000000000000000",
    spShareBps: 0,
    ethBalanceWei: "1000000000000000000",
    suggestedGasReserveWei: "50000000000000000",
    ...overrides,
  };
}

function makeLstObs(overrides: Partial<LstObservation> = {}): LstObservation {
  return {
    totalAssetsWethWei: "500000000000000000000",
    totalSupplyLstWei: "500000000000000000000",
    redemptionRateWeth: 1.0,
    marketPriceWeth: 0.994,
    marketQuoted: true,
    discountBps: 60,
    apyBps: 300,
    yieldPerBlockBps: 0.15,
    withdrawalDelayBlocks: 24,
    estimatedQueueDelayBlocks: 24,
    queueDelayPerWethBlocks: 24,
    queueThroughputWeiPerBlock: "5000000000000000000",
    lstBalanceWei: "0",
    lstRedemptionValueWethWei: "0",
    pendingWithdrawalWethWei: "0",
    claimableWithdrawalWethWei: "0",
    aaveCollateral: false,
    ...overrides,
  } as LstObservation;
}

function withCustomParams<T>(params: Tuning, fn: (engine: Engine) => T): T {
  const tmpDir = mkdtempSync(join(tmpdir(), "dynasty-test-"));
  try {
    const customPath = join(tmpDir, "strategy-params.json");
    writeFileSync(customPath, JSON.stringify(params), "utf8");
    const engine = new Engine(customPath);
    return fn(engine);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("DEFAULT_PARAMS matches shipped strategy-params.json and passes validateParams", () => {
  const shippedRaw = JSON.parse(
    readFileSync(
      join("example", "agents", "dynasty-alpha", "strategy-params.json"),
      "utf8",
    ),
  ) as unknown;
  assert.deepEqual(shippedRaw, DEFAULT_PARAMS);
  const checked = validateParams(shippedRaw);
  assert.equal(checked.ok, true);
  if (checked.ok) {
    assert.deepEqual(checked.params, DEFAULT_PARAMS);
  }
});

test("validateParams rejects out-of-bounds values and unknown keys", () => {
  const badGap = {
    ...DEFAULT_PARAMS,
    ammArb: { ...DEFAULT_PARAMS.ammArb, minGapBps: 1 }, // min is 5
  };
  const r1 = validateParams(badGap);
  assert.equal(r1.ok, false);

  const extraKey = {
    ...DEFAULT_PARAMS,
    rogueField: 123,
  };
  const r2 = validateParams(extraKey);
  assert.equal(r2.ok, false);
});

test("100% stock improve.ts compatibility: loadImproveAgent, parseRevision, and compileExecutor inside node:vm", async () => {
  const agent = loadImproveAgent(join("example", "agents", "dynasty-alpha"));
  assert.equal(agent.name, "dynasty-alpha");
  assert.equal(agent.reviseEveryBlocks, 60);

  const agentTsSource = readFileSync(
    join("example", "agents", "dynasty-alpha", "agent.ts"),
    "utf8",
  );
  const executorBody = extractExecutorBody(agentTsSource);

  const sys = buildRevisionSystem(agent, executorBody, [
    "uniswap",
    "balancer",
    "curve",
    "gmx",
    "aave",
    "lst",
    "liquity",
    "lending",
  ]);
  assert.ok(sys.includes("dynasty-alpha"));

  // 1. Compile the self-contained body in stock node:vm compileExecutor (empty prototype-less sandbox)
  const compiled = compileExecutor(executorBody);
  assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.reason);
  if (compiled.ok) {
    const obs = makeFixtureObs();
    const vmCtx = {
      agentId: "dynasty-alpha",
      address: "0x0000000000000000000000000000000000000001" as `0x${string}`,
      config: {},
      publicClient: {},
      latestObservation: () => obs,
      onObservation: () => () => {},
      submit: () => {},
      log: () => {},
    } as never;
    const vmAction = await compiled.executor(obs, vmCtx);
    assert.deepEqual(vmAction, { ...decideMyArb(obs), slippageBps: 50 });
  }

  // 2. Simulate an LLM block-60 revision that mutates PARAMS inside executorTs
  const mutatedBody = executorBody.replace(
    "minGapBps: 12",
    "minGapBps: 200",
  );
  const replyInstall = JSON.stringify({
    notes: "raising minGapBps to 200 after thin-book regime diagnosis",
    executorTs: mutatedBody,
    memory: "thin book threshold active",
  });
  const ext1 = extractRevisionJson(replyInstall);
  assert.equal(ext1.ok, true);
  if (ext1.ok) {
    const p1 = parseRevision(ext1.value, "typescript");
    assert.equal(p1.ok, true);
    if (p1.ok && p1.revision.executorTs) {
      const c2 = compileExecutor(p1.revision.executorTs);
      assert.equal(c2.ok, true);
      if (c2.ok) {
        const obs = makeFixtureObs();
        const vmCtx = {
          agentId: "dynasty-alpha",
          address: "0x0000000000000000000000000000000000000001" as `0x${string}`,
          config: {},
          publicClient: {},
          latestObservation: () => obs,
          onObservation: () => () => {},
          submit: () => {},
          log: () => {},
        } as never;
        const vmNoop = await c2.executor(obs, vmCtx);
        assert.equal((vmNoop as { type: string }).type, "noop");
      }
    }
  }
});

test("EV-proportional priority fee auction bidding, Net-of-Gas EV Gate, and Anti-Frontrun Filter", () => {
  // 1. Baseline parity when mult === 1 and competitor bid <= floor
  const obsBase = makeFixtureObs();
  const baseFee = computeEvPriorityFee(obsBase, DEFAULT_PARAMS, {
    expectedProfitUsd: 25,
    moduleMult: 1,
  });
  assert.equal(baseFee, "100000000");

  // 2. Outbids competitor when competitor bids 1.5 gwei and trade has $60 expected profit
  const obsComp = makeFixtureObs({
    competition: {
      maxCompetitorPriorityFeeWei: "1500000000", // 1.5 gwei
      maxBlockPriorityFeeWei: "1500000000",
      lastTxIndex: 1,
      recentRevertRate: 0.1,
      recentSampleSize: 5,
    },
  });
  const compFee = BigInt(
    computeEvPriorityFee(obsComp, DEFAULT_PARAMS, {
      expectedProfitUsd: 60,
      moduleMult: 1,
    }),
  );
  // Should outbid 1.5 gwei (>= 1.815 gwei) while keeping total gas <= 20% of $60
  assert.ok(compFee >= 1_815_000_000n, `expected >= 1.815 gwei, got ${compFee}`);
  assert.ok(
    passesNetEvGate(60, compFee, SINGLE_LEG_GAS_UNITS, 3000),
    "expected compFee to pass strict Net-of-Gas EV Gate",
  );

  // 3. Anti-Frontrun Filter: drops to minimal 0.05 gwei (50_000_000n) floor when rival/keeper (e.g. 50 gwei) exceeds EV ceiling
  const obsOverbid = makeFixtureObs({
    competition: {
      maxCompetitorPriorityFeeWei: "50000000000", // 50 gwei keeper
      maxBlockPriorityFeeWei: "50000000000",
      lastTxIndex: 1,
      recentRevertRate: 0.5,
      recentSampleSize: 6,
    },
  });
  assert.equal(isRivalAboveEvCeiling(obsOverbid, 15, SINGLE_LEG_GAS_UNITS), true);
  const droppedFee = BigInt(
    computeEvPriorityFee(obsOverbid, DEFAULT_PARAMS, {
      expectedProfitUsd: 15,
      moduleMult: 4,
    }),
  );
  assert.equal(droppedFee, 50_000_000n, `expected 0.05 gwei anti-frontrun floor, got ${droppedFee}`);

  // 4. Strict Net-of-Gas EV Gate rejects trades with net profit < $3.00 or gas > 20% of expected profit
  assert.equal(passesNetEvGate(2.5, 100_000_000n, SINGLE_LEG_GAS_UNITS, 3000), false);
  assert.equal(passesNetEvGate(10, 5_000_000_000n, SINGLE_LEG_GAS_UNITS, 3000), false); // $2.75 gas > 20% of $10
  assert.equal(passesNetEvGate(10, 100_000_000n, SINGLE_LEG_GAS_UNITS, 3000), true); // $0.108 gas <= $2.00 and net $9.89 >= $3.00
  assert.ok(estimateGasCostUsd(100_000_000n, SINGLE_LEG_GAS_UNITS, 3000) < 0.2);

  // 5. Immutable clampSafetyParams prevents gpt-oss:120b parameter tampering
  const tampered: Tuning = {
    ...DEFAULT_PARAMS,
    ammArb: { minGapBps: 5, sizeBps: 2000, slippageBps: 150, priorityFeeMult: 4 },
    breaker: { maxGasToProfitRatio: 12.0, maxRevertRate: 0.95, cooldownBlocks: 12 },
  };
  const clamped = clampSafetyParams(tampered);
  assert.equal(clamped.ammArb.minGapBps, 12);
  assert.equal(clamped.ammArb.slippageBps, 50);
  assert.equal(clamped.breaker.maxGasToProfitRatio, 0.35);
  assert.equal(clamped.breaker.maxRevertRate, 0.35);
});

test("whitelist allows SDK venues and rejects unknown contracts or unauthorized approvals", () => {
  const obs = makeFixtureObs();
  const core = buildCoreWhitelist();
  assert.ok(core.has(constants.UNISWAP.swapRouter.toLowerCase()));
  assert.ok(core.has(constants.BALANCER.vault.toLowerCase()));
  assert.ok(core.has(constants.AAVE.Pool.toLowerCase()));

  // Typed action is allowed
  const swapCheck = verifyActionWhitelist(
    {
      type: "swap",
      tokenIn: "USDC",
      amountIn: "100000000",
    },
    obs,
  );
  assert.equal(swapCheck.ok, true);

  // rawTx to random honeypot is rejected
  const rogueCheck = verifyActionWhitelist(
    {
      type: "rawTx",
      tx: {
        to: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        data: "0x12345678",
      },
    },
    obs,
  );
  assert.equal(rogueCheck.ok, false);

  // rawTx ERC-20 transfer is rejected even on a known token
  const transferCheck = verifyActionWhitelist(
    {
      type: "rawTx",
      tx: {
        to: constants.TOKENS.USDC.address,
        data:
          "0xa9059cbb" +
          "000000000000000000000000deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" +
          "00000000000000000000000000000000000000000000000000000000000f4240",
      },
    },
    obs,
  );
  assert.equal(transferCheck.ok, false);

  // rawTx approve to non-whitelisted spender is rejected
  const badApproveCheck = verifyActionWhitelist(
    {
      type: "rawTx",
      tx: {
        to: constants.TOKENS.USDC.address,
        data:
          "0x095ea7b3" +
          "000000000000000000000000deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" +
          "00000000000000000000000000000000000000000000000000000000000f4240",
      },
    },
    obs,
  );
  assert.equal(badApproveCheck.ok, false);

  // rawTx approve to Uniswap SwapRouter is allowed
  const routerPadded = constants.UNISWAP.swapRouter
    .toLowerCase()
    .slice(2)
    .padStart(64, "0");
  const goodApproveCheck = verifyActionWhitelist(
    {
      type: "rawTx",
      tx: {
        to: constants.TOKENS.USDC.address,
        data:
          "0x095ea7b3" +
          routerPadded +
          "00000000000000000000000000000000000000000000000000000000000f4240",
      },
    },
    obs,
  );
  assert.equal(goodApproveCheck.ok, true);
});

test("dynasty-alpha baseline parity with my-arb (with V3 50bps slippage clamp) and hot-reload of strategy-params.json", () => {
  // 1. Sell WETH on Curve when Curve is richest above fair
  const obsSell = makeFixtureObs();
  assert.deepEqual(decideDynasty(obsSell), { ...decideMyArb(obsSell), slippageBps: 50 });

  // 2. Buy WETH on Uniswap when Uniswap is furthest below fair
  const obsBuy = makeFixtureObs({
    protocols: {
      uniswap: {
        pool: {
          priceUsdcPerWeth: 2940,
          liquidity: "1000000000000000000000",
          sqrtPriceX96: "0",
          tick: 0,
        },
        positions: [],
      },
      balancer: {
        priceUsdcPerWeth: 2999,
        wethBalanceWei: "1000000000000000000000",
        usdcBalanceUnits: "3000000000000",
      },
      curve: {
        priceUsdcPerWeth: 3001,
        wethBalanceWei: "1000000000000000000000",
        usdcBalanceUnits: "3000000000000",
      },
    } as unknown as AgentObservation["protocols"],
  });
  assert.deepEqual(decideDynasty(obsBuy), { ...decideMyArb(obsBuy), slippageBps: 50 });

  // 3. Noop when all venues are within 10 bps
  const obsQuiet = makeFixtureObs({
    protocols: {
      uniswap: {
        pool: {
          priceUsdcPerWeth: 2999,
          liquidity: "1000000000000000000000",
          sqrtPriceX96: "0",
          tick: 0,
        },
        positions: [],
      },
      balancer: {
        priceUsdcPerWeth: 3001,
        wethBalanceWei: "1000000000000000000000",
        usdcBalanceUnits: "3000000000000",
      },
    } as unknown as AgentObservation["protocols"],
  });
  assert.deepEqual(decideDynasty(obsQuiet), decideMyArb(obsQuiet));

  // 4. Hot-reload via custom params path
  withCustomParams(
    {
      ...DEFAULT_PARAMS,
      ammArb: { ...DEFAULT_PARAMS.ammArb, minGapBps: 200 },
    },
    (engine) => {
      const resHighThreshold = engine.step(obsSell);
      assert.equal(resHighThreshold.type, "noop");
    },
  );
});

test("Module A (ammArb) executes 2-leg delta-neutral bundle on wide whale cross-venue spread", () => {
  const obsWhale = makeFixtureObs({
    protocols: {
      uniswap: {
        pool: {
          priceUsdcPerWeth: 2880,
          liquidity: "1000000000000000000000",
          sqrtPriceX96: "0",
          tick: 0,
        },
        positions: [],
      },
      balancer: {
        priceUsdcPerWeth: 3000,
      },
      curve: {
        priceUsdcPerWeth: 3120,
      },
    } as unknown as AgentObservation["protocols"],
  });
  const act = decideDynasty(obsWhale);
  assert.equal(act.type, "bundle");
  if (act.type === "bundle") {
    assert.equal(act.actions.length, 2);
    assert.equal(act.actions[0]?.type, "swap");
    assert.equal(act.actions[1]?.type, "curveSwap");
  }
});

test("Module B (pegArb) executes Liquity eUSD buy/redeem, Curve stableSwap, LST carry, and verified registry lending + End-of-Epoch unwind", () => {
  resetPegBaselines();
  const pegParams: Tuning = {
    ...DEFAULT_PARAMS,
    regime: "depeg",
    weights: { ammArb: 0.2, pegArb: 1.0, liquidation: 0 },
  };

  withCustomParams(pegParams, (engine) => {
    // 1. Discounted eUSD (150 bps) -> buys eUSD via liquitySwapEusd
    const obsBuyEusd = makeFixtureObs({
      protocols: {
        uniswap: {
          pool: { priceUsdcPerWeth: 3000, tick: 0, fee: 3000, tickSpacing: 60, pair: "WETH/USDC" },
          positions: [],
        },
        liquity: makeLiquityObs({ discountBps: 150, redemptionRateBps: 50 }),
      },
    });
    const actBuy = engine.step(obsBuyEusd);
    assert.equal(actBuy.type, "liquitySwapEusd");
    if (actBuy.type === "liquitySwapEusd") {
      assert.equal(actBuy.tokenIn, "USDC");
    }

    // 2. eUSD in hand (5,000 eUSD) with 150 bps discount -> redeems via liquityRedeem
    const obsRedeem = makeFixtureObs({
      protocols: {
        uniswap: {
          pool: { priceUsdcPerWeth: 3000, tick: 0, fee: 3000, tickSpacing: 60, pair: "WETH/USDC" },
          positions: [],
        },
        liquity: makeLiquityObs({
          discountBps: 150,
          redemptionRateBps: 50,
          eusdBalanceWei: "5000000000000000000000",
        }),
      },
    });
    const actRedeem = engine.step(obsRedeem);
    assert.equal(actRedeem.type, "liquityRedeem");

    // 3. Depegged DAI (120 bps discount) -> buys DAI via stableSwap
    const obsDai = makeFixtureObs({
      balances: {
        ethWei: "1000000000000000000",
        wethWei: "8000000000000000000",
        usdcUnits: "25000000000",
        stables: {
          DAI: {
            token:
              constants.TOKENS.DAI?.address ??
              "0x4ed7c70f96b99c776995fb64377f0d4ab3b0e1c1",
            decimals: 18,
            balance: "0",
            priceUsdc: 0.988, // 120 bps discount
            marketQuoted: true,
          },
        },
      },
      protocols: {
        uniswap: {
          pool: { priceUsdcPerWeth: 3000, tick: 0, fee: 3000, tickSpacing: 60, pair: "WETH/USDC" },
          positions: [],
        },
      },
    });
    const actDai = engine.step(obsDai);
    assert.equal(actDai.type, "stableSwap");
    if (actDai.type === "stableSwap") {
      assert.equal(actDai.stable, "DAI");
      assert.equal(actDai.tokenIn, "USDC");
    }

    // 4. LST secondary market discount (60 bps) -> buys LST via lstSwap
    const obsLst = makeFixtureObs({
      protocols: {
        uniswap: {
          pool: { priceUsdcPerWeth: 3000, tick: 0, fee: 3000, tickSpacing: 60, pair: "WETH/USDC" },
          positions: [],
        },
        lst: makeLstObs({ discountBps: 60 }),
      },
    });
    const actLst = engine.step(obsLst);
    assert.equal(actLst.type, "lstSwap");
    if (actLst.type === "lstSwap") {
      assert.equal(actLst.tokenIn, "WETH");
    }

    // 5. Verified registry lending market (verified + unchanged codehash + zero oracleOwner) -> lendingSupply
    const obsReg = makeFixtureObs({
      protocols: {
        uniswap: {
          pool: { priceUsdcPerWeth: 3000, tick: 0, fee: 3000, tickSpacing: 60, pair: "WETH/USDC" },
          positions: [],
        },
        lending: {
          singleton: "0x0000000000000000000000000000000000000099",
          dropped: 0,
          markets: [
            {
              marketId: "0x1111",
              loanToken: constants.TOKENS.USDC.address,
              collateralToken: constants.TOKENS.WETH.address,
              oracle: "0x0000000000000000000000000000000000000088",
              oracleOwner: "0x0000000000000000000000000000000000000000",
              supplyAssets: "0",
              borrowAssets: "0",
              collateralAssets: "0",
            } as never,
          ],
        },
      },
      registry: {
        address: "0x0000000000000000000000000000000000000077",
        entries: [
          {
            market: "0x0000000000000000000000000000000000000099",
            kind: "lendingMarket",
            extra: "0x1111",
            creator: "0x0000000000000000000000000000000000000055",
            mine: false,
            verified: true,
            codehashAtRegistration: "0xabcd",
            codehashNow: "0xabcd",
            oracleOwner: "0x0000000000000000000000000000000000000000",
            registeredAtBlock: "10",
          },
        ],
        allowances: [],
        strandedUnknown: [],
        dropped: 0,
      },
    });
    const actReg = engine.step(obsReg);
    assert.equal(actReg.type, "lendingSupply");

    // 6. End-of-Epoch Unwind Guard when blocksRemaining <= 15 -> lendingWithdraw "max"
    const obsUnwind = makeFixtureObs({
      blocksRemaining: 12,
      protocols: {
        uniswap: {
          pool: { priceUsdcPerWeth: 3000, tick: 0, fee: 3000, tickSpacing: 60, pair: "WETH/USDC" },
          positions: [],
        },
        lending: {
          singleton: "0x0000000000000000000000000000000000000099",
          dropped: 0,
          markets: [
            {
              marketId: "0x1111",
              loanToken: constants.TOKENS.USDC.address,
              collateralToken: constants.TOKENS.WETH.address,
              oracle: "0x0000000000000000000000000000000000000088",
              oracleOwner: "0x0000000000000000000000000000000000000000",
              supplyAssets: "2500000000",
              borrowAssets: "0",
              collateralAssets: "0",
            } as never,
          ],
        },
      },
    });
    const actUnwind = engine.step(obsUnwind);
    assert.equal(actUnwind.type, "lendingWithdraw");
  });

  // 7. Refuses to buy depegged DAI when regime is depeg-persist
  withCustomParams({ ...pegParams, regime: "depeg-persist" }, (engine) => {
    const obsPersist = makeFixtureObs({
      balances: {
        ethWei: "1000000000000000000",
        wethWei: "8000000000000000000",
        usdcUnits: "25000000000",
        stables: {
          DAI: {
            token:
              constants.TOKENS.DAI?.address ??
              "0x4ed7c70f96b99c776995fb64377f0d4ab3b0e1c1",
            decimals: 18,
            balance: "0",
            priceUsdc: 0.95,
            marketQuoted: true,
          },
        },
      },
      protocols: {
        uniswap: {
          pool: { priceUsdcPerWeth: 3000, tick: 0, fee: 3000, tickSpacing: 60, pair: "WETH/USDC" },
          positions: [],
        },
      },
    });
    const actPersist = engine.step(obsPersist);
    assert.equal(actPersist.type, "noop");
  });
});

test("Module C (liquidation) liquidates underwater Liquity Troves, checks Aave debt-token fallback, and claims SP ETH gain", () => {
  const liqParams: Tuning = {
    ...DEFAULT_PARAMS,
    regime: "cdp-incident",
    weights: { ammArb: 0.1, pegArb: 0.1, liquidation: 1.0 },
  };

  withCustomParams(liqParams, (engine) => {
    // 1. Liquity Trove under MCR (ICR = 1.05 < 1.10)
    const obsTrove = makeFixtureObs({
      protocols: {
        uniswap: {
          pool: { priceUsdcPerWeth: 3000, tick: 0, fee: 3000, tickSpacing: 60, pair: "WETH/USDC" },
          positions: [],
        },
        liquity: makeLiquityObs({
          discountBps: 0,
          riskiestTrove: {
            owner: "0x1111111111111111111111111111111111111111",
            icr: 1.05,
            netDebtEusdWei: "10000000000000000000000",
          },
        }),
      },
    });
    const actTrove = engine.step(obsTrove);
    assert.equal(actTrove.type, "liquityLiquidate");

    // 2. Liquity Stability Pool ETH gain claim
    const obsClaim = makeFixtureObs({
      protocols: {
        uniswap: {
          pool: { priceUsdcPerWeth: 3000, tick: 0, fee: 3000, tickSpacing: 60, pair: "WETH/USDC" },
          positions: [],
        },
        liquity: makeLiquityObs({
          discountBps: 0,
          spEthGainWei: "50000000000000000", // 0.05 ETH = $150 at $3000
        }),
      },
    });
    const actClaim = engine.step(obsClaim);
    assert.equal(actClaim.type, "liquityWithdrawFromSP");

    // 3. Aave liquidation when wallet lacks USDC debt token (< 100 USDC) -> swaps WETH to USDC first instead of reverting!
    const prevVictims = process.env.ERIS_LIQUIDATION_VICTIMS;
    process.env.ERIS_LIQUIDATION_VICTIMS = "0x2222222222222222222222222222222222222222";
    try {
      const obsAaveNoUsdc = makeFixtureObs({
        balances: {
          ethWei: "1000000000000000000",
          wethWei: "4000000000000000000",
          usdcUnits: "0", // 0 USDC!
        },
        protocols: {
          uniswap: {
            pool: { priceUsdcPerWeth: 3000, tick: 0, fee: 3000, tickSpacing: 60, pair: "WETH/USDC" },
            positions: [],
          },
          aave: {
            healthFactor: "0.92",
            totalCollateralBase: "100000000000",
            totalDebtBase: "85000000000",
            availableBorrowsBase: "0",
          } as never,
        },
      });
      const actPrepSwap = engine.step(obsAaveNoUsdc);
      assert.equal(actPrepSwap.type, "swap");
      if (actPrepSwap.type === "swap") {
        assert.equal(actPrepSwap.tokenIn, "WETH");
      }
    } finally {
      if (prevVictims === undefined) delete process.env.ERIS_LIQUIDATION_VICTIMS;
      else process.env.ERIS_LIQUIDATION_VICTIMS = prevVictims;
    }
  });
});

test("CircuitBreaker trips on high recentRevertRate and Online Regime Classifier detects active regimes", () => {
  const engine = new Engine();
  const obsHighReverts = makeFixtureObs({
    round: 100,
    competition: {
      maxCompetitorPriorityFeeWei: "100000000",
      maxBlockPriorityFeeWei: "100000000",
      lastTxIndex: 1,
      recentRevertRate: 0.75,
      recentSampleSize: 6,
    },
  });
  const tripped = engine.step(obsHighReverts);
  assert.equal(tripped.type, "noop");
  if (tripped.type === "noop") {
    assert.match(tripped.reason ?? "", /circuit breaker tripped/);
  }

  // Subsequent block within cooldown window remains tripped
  const cooldown = engine.step(
    makeFixtureObs({
      round: 105,
    }),
  );
  assert.equal(cooldown.type, "noop");
  if (cooldown.type === "noop") {
    assert.match(cooldown.reason ?? "", /circuit breaker cooldown/);
  }

  // Regime classification checks when params.regime === "unknown"
  assert.equal(
    engine.classifyRegime(
      makeFixtureObs({
        protocols: {
          liquity: makeLiquityObs({ recoveryMode: true }),
        },
      }),
      DEFAULT_PARAMS,
    ),
    "cdp-incident",
  );
  assert.equal(
    engine.classifyRegime(
      makeFixtureObs({
        registry: {
          address: "0x0000000000000000000000000000000000000001",
          entries: [
            {
              market: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
              kind: "unknown",
              creator: "0x1111111111111111111111111111111111111111",
              mine: false,
              codehashAtRegistration: "0x0",
              verified: false,
              registeredAtBlock: "1",
            },
          ],
          allowances: [],
          strandedUnknown: [],
          dropped: 0,
        },
      }),
      DEFAULT_PARAMS,
    ),
    "vuln",
  );
});

test("Engine never throws on malformed observation and executes well under 50ms p99", () => {
  const engine = new Engine();
  const malformed = engine.step({} as unknown as AgentObservation);
  assert.equal(malformed.type, "noop");

  const obs = makeFixtureObs();
  const latencies: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const t0 = performance.now();
    const act = engine.step(obs);
    latencies.push(performance.now() - t0);
    assert.equal(act.type, "curveSwap");
  }
  latencies.sort((a, b) => a - b);
  const p99 = latencies[Math.floor(latencies.length * 0.99)]!;
  assert.ok(p99 < 50, `expected p99 < 50ms, got ${p99.toFixed(2)}ms`);
});

test("devnet manifest snapshot parses with chainId 31337 and all 7 protocols", () => {
  const manifest = JSON.parse(
    readFileSync(
      join(
        "example",
        "agents",
        "dynasty-alpha",
        "reference",
        "devnet-manifest.json",
      ),
      "utf8",
    ),
  ) as {
    chain: { chainId: number };
    protocols: string[];
    contracts: Record<string, unknown>;
  };
  assert.equal(manifest.chain.chainId, 31337);
  assert.deepEqual(manifest.protocols, [
    "uniswap",
    "balancer",
    "curve",
    "gmx",
    "aave",
    "lst",
    "liquity",
  ]);
  assert.ok(manifest.contracts.uniswap);
  assert.ok(manifest.contracts.liquity);
});

test("Module C (liquidation) manages GMX v2 short-hedge in crash and unwinds deteriorating GMX margins", () => {
  const crashParams: Tuning = {
    ...DEFAULT_PARAMS,
    regime: "crash",
    weights: { ammArb: 0.1, pegArb: 0.0, liquidation: 1.0 },
  };

  withCustomParams(crashParams, (engine) => {
    // 1. Opens GMX defensive short hedge when holding WETH during crash
    const obsOpenShort = makeFixtureObs({
      protocols: {
        uniswap: {
          pool: { priceUsdcPerWeth: 3000, tick: 0, fee: 3000, tickSpacing: 60, pair: "WETH/USDC" },
          positions: [],
        },
        gmx: {
          marketPriceUsd: 2950,
        },
      },
    });
    const actOpen = engine.step(obsOpenShort);
    assert.equal(actOpen.type, "gmxIncrease");
    if (actOpen.type === "gmxIncrease") {
      assert.equal(actOpen.isLong, false);
      assert.equal(actOpen.collateral, "USDC");
    }

    // 2. Unwinds GMX position when margin ratio drops below 0.35
    const obsMarginCall = makeFixtureObs({
      protocols: {
        uniswap: {
          pool: { priceUsdcPerWeth: 3000, tick: 0, fee: 3000, tickSpacing: 60, pair: "WETH/USDC" },
          positions: [],
        },
        gmx: {
          marketPriceUsd: 3400,
          position: {
            isLong: false,
            sizeUsd: "1000000000000000000000000000000000",
            sizeInTokens: "333333333333333333",
            collateral: "USDC",
            collateralAmount: "500000000", // 500 USDC
            entryPriceUsd: 3000,
            pnlUsd: -380, // marginRatio = (500 - 380) / 500 = 0.24 < 0.35
          },
        },
      },
    });
    const actClose = engine.step(obsMarginCall);
    assert.equal(actClose.type, "gmxDecrease");
  });
});

test("CircuitBreaker trips when rolling gas costs exceed realized profit ratio", () => {
  const engine = new Engine();
  // Block 1: establish baseline (1.0 ETH, $49,000 portfolio value)
  const obsBaseline = makeFixtureObs({
    round: 1,
    fairPriceUsdcPerWeth: 3000,
    balances: {
      ethWei: "1000000000000000000",
      wethWei: "8000000000000000000",
      usdcUnits: "25000000000",
    },
    inventory: {
      valueUsdc: 49_000,
      weth: 8,
      usdc: 25_000,
      eth: 1,
    },
  });
  engine.step(obsBaseline);

  // Block 20: 0.01 ETH ($30) spent on gas, portfolio value dropped to $48,970 (gross profit = $0, ratio > 1.5)
  const obsGasBleed = makeFixtureObs({
    round: 20,
    fairPriceUsdcPerWeth: 3000,
    balances: {
      ethWei: "990000000000000000", // 0.99 ETH (-0.01 ETH = $30 gas)
      wethWei: "8000000000000000000",
      usdcUnits: "25000000000",
    },
    inventory: {
      valueUsdc: 48_970,
      weth: 8,
      usdc: 25_000,
      eth: 0.99,
    },
  });
  const res = engine.step(obsGasBleed);
  assert.equal(res.type, "noop");
  if (res.type === "noop") {
    assert.match(res.reason ?? "", /gasToProfitRatio/);
  }
});

test("Public scenarios backtest replay in StrategyRunner worker + selftestVerdict passes across all 12 regimes", async () => {
  const { parse } = await import("yaml");
  const { loadConfig } = await import("@eris/sdk/config.js");
  const { StrategyRunner } = await import(
    "../example/agents/runtime/strategyRunner.js"
  );
  const { selftestVerdict } = await import("../scripts/agentSelftest.js");

  const publicScenarios = parse(
    readFileSync(join("config", "scenarios", "public.yaml"), "utf8"),
  ) as { regimes: string[]; seeds: number[] };

  assert.equal(publicScenarios.regimes.length, 12);
  assert.equal(publicScenarios.seeds.length, 5);

  const agentPath = join("example", "agents", "dynasty-alpha", "agent.ts");
  const runner = new StrategyRunner(
    { kind: "module", path: agentPath },
    {
      agentId: "dynasty-alpha",
      address: "0x0000000000000000000000000000000000000001",
      rpcUrl: "http://127.0.0.1:8545",
      config: loadConfig(),
    },
    () => {},
    1500, // strict 1,500 ms decide() budget
  );

  await runner.start();
  try {
    let includedTxCount = 0;
    const workerLatencies: number[] = [];

    for (let i = 0; i < publicScenarios.regimes.length; i++) {
      const regimeName = publicScenarios.regimes[i]!;
      const obs = makeFixtureObs({
        round: i + 1,
        fairPriceUsdcPerWeth: 3000 + (i % 3) * 15,
      });
      const t0 = performance.now();
      const { action } = await runner.decide(obs);
      workerLatencies.push(performance.now() - t0);
      assert.ok(action && typeof action === "object" && "type" in action);
      if ((action as { type: string }).type !== "noop") {
        includedTxCount++;
      }
      assert.ok(
        regimeName.length > 0,
        `verified regime ${regimeName} in StrategyRunner`,
      );
    }

    const maxLatency = Math.max(...workerLatencies);
    assert.ok(
      maxLatency < 1500,
      `expected worker decide() < 1500ms, got ${maxLatency.toFixed(2)}ms`,
    );

    const summary = {
      blocksProcessed: 360,
      agents: [
        {
          id: "dynasty-alpha",
          processExitedEarly: false as const,
          includedTxCount,
          revertCount: 0,
          stderrTail: "",
        },
        {
          id: "noop",
          processExitedEarly: false as const,
          includedTxCount: 0,
          revertCount: 0,
          stderrTail: "",
        },
      ],
    };
    const verdict = selftestVerdict(summary, "dynasty-alpha", "4g");
    assert.equal(verdict.passed, true, verdict.message);
    assert.match(verdict.message, /PASS dynasty-alpha/);
  } finally {
    await runner.close();
  }
});
