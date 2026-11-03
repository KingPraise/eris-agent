# Dynasty-Alpha (`ASCON-S-00074`)

**Tri-Modal Adaptive Regime Engine & Sandboxed VM Execution for the ASCON Autonomous Trading Competition**

- **Author / Participant:** King Praise (`0xe40DA7Ac0ca9C21fe19527d31977184f0a82e6e2`)
- **Official Submission ID:** `ASCON-S-00074` (V3 Hardened Release)
- **60-Epoch Tournament Score:** **`64.03` (Rank #1 Overall)** | Mean Alpha: **`+$2,007.54` / epoch**
- **Live On-Chain Revert Rate:** **`0.00%`** (`202 / 202` transactions succeeded on `https://ascon-rpc.nyx.foundation/`)
- **Technical Report:** [Markdown](../../../docs/dynasty-alpha-technical-report.md) · [Executive PDF](../../../docs/dynasty-alpha-technical-report.pdf)

---

## Directory Layout

```text
example/agents/dynasty-alpha/
├── agent.ts                    # Entry point: v0 Engine delegation + self-contained v1+ VM sandbox body
├── StrategyTuning.ts           # Strongly-typed StrategyParams schema + clampSafetyParams() normalizer
├── strategy-params.json        # Baseline calibrated parameters across all 4 modules
├── prompt.md                   # Block-60 out-of-band LLM revision policy (kind: improve)
├── engine/
│   ├── Engine.ts               # Deterministic sub-millisecond orchestrator & regime classifier
│   ├── priorityFee.ts          # Net-of-Gas EV gate, dynamic tip curve & 35+ gwei keeper spike filter
│   ├── circuitBreaker.ts       # Delta-neutral PnL accounting, revert tracking & drawdown breaker
│   ├── params.ts               # Runtime parameter loader & validator
│   ├── whitelist.ts            # Manifest-enforced contract allowlist (anti-honeypot guard)
│   └── telemetry.ts            # Structured JSONL decision & regime telemetry logger
├── modules/
│   ├── ammArb.ts               # Module A: Convex cross-pool AMM arbitrage (Uniswap V3, Curve NG, Balancer V2)
│   ├── pegArb.ts               # Module B: Liquity eUSD redemption arbitrage & Stability Pool underwriting
│   ├── liquidation.ts          # Module C: Aave V3 Health Factor & GMX V2 margin liquidation sniper
│   └── lstAndDiscovery.ts      # Module D: LST staking carry & MarketRegistry discovery
└── reference/
    └── devnet-manifest.json    # Reference Eris L2 practice devnet contract manifest
```

---

## Verification & Commands

```bash
# 1. Run the 15-test unit & integration suite
node --import tsx --test test/dynasty-alpha.test.ts

# 2. Run static strategy code & sandbox verification across all 10 TypeScript files
npm run check:strategy -- example/agents/dynasty-alpha/agent.ts

# 3. Execute the 60-epoch (12 regimes x 5 seeds) head-to-head benchmark
npx tsx scripts/benchmark-12-regimes.ts

# 4. Build the self-contained competition submission bundle
npm run bundle:agent -- example/agents/dynasty-alpha --out bundle-dynasty-alpha.zip
```
