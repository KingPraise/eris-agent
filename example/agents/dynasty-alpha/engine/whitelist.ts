import type {
  AgentAction,
  AgentObservation,
  RawTx,
} from "@eris/sdk";
import * as constants from "@eris/sdk/constants.js";
import { FLASH_ARB_ADDRESS } from "@eris/sdk/wellKnown.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const SELECTOR_TRANSFER = "0xa9059cbb";
const SELECTOR_TRANSFER_FROM = "0x23b872dd";
const SELECTOR_SAFE_TRANSFER_FROM = "0x42842e0e";
const SELECTOR_SAFE_TRANSFER_FROM_DATA = "0xb88d4fde";
const SELECTOR_SET_APPROVAL_FOR_ALL = "0xa22cb465";
const SELECTOR_APPROVE = "0x095ea7b3";
const SELECTOR_INCREASE_ALLOWANCE = "0x39509351";
const SELECTOR_PERMIT = "0xd505accf";

const FORBIDDEN_SELECTORS: Record<string, string> = {
  [SELECTOR_TRANSFER]: "transfer",
  [SELECTOR_TRANSFER_FROM]: "transferFrom",
  [SELECTOR_SAFE_TRANSFER_FROM]: "safeTransferFrom",
  [SELECTOR_SAFE_TRANSFER_FROM_DATA]: "safeTransferFrom",
  [SELECTOR_SET_APPROVAL_FOR_ALL]: "setApprovalForAll",
};

const APPROVAL_SELECTORS: Record<string, { name: string; spenderWord: number }> = {
  [SELECTOR_APPROVE]: { name: "approve", spenderWord: 0 },
  [SELECTOR_INCREASE_ALLOWANCE]: { name: "increaseAllowance", spenderWord: 0 },
  [SELECTOR_PERMIT]: { name: "permit", spenderWord: 1 },
};

const TYPED_ACTIONS = new Set<string>([
  "noop",
  "bundle",
  "swap",
  "mintLiquidity",
  "removeLiquidity",
  "collectFees",
  "createPool",
  "balancerSwap",
  "curveSwap",
  "stableSwap",
  "gmxIncrease",
  "gmxDecrease",
  "aaveSupply",
  "aaveWithdraw",
  "aaveBorrow",
  "aaveRepay",
  "lstDeposit",
  "lstSwap",
  "lstRequestWithdraw",
  "lstClaimWithdraw",
  "liquityOpenTrove",
  "liquityAdjustTrove",
  "liquityCloseTrove",
  "liquityRedeem",
  "liquityProvideToSP",
  "liquityWithdrawFromSP",
  "liquityLiquidate",
  "liquitySwapEusd",
  "createLendingMarket",
  "lendingSupply",
  "lendingWithdraw",
  "lendingSupplyCollateral",
  "lendingWithdrawCollateral",
  "lendingBorrow",
  "lendingRepay",
  "lendingLiquidate",
]);

function collectAddresses(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (ADDRESS_RE.test(value)) into.add(value.toLowerCase());
    return;
  }
  if (typeof value !== "object") return;
  for (const v of Object.values(value as Record<string, unknown>)) {
    collectAddresses(v, into, depth + 1);
  }
}

let cachedCoreWhitelist: Set<string> | undefined;

export function buildCoreWhitelist(): ReadonlySet<string> {
  if (cachedCoreWhitelist) return cachedCoreWhitelist;
  const set = new Set<string>();
  const {
    TOKENS,
    USDC_VARIANTS,
    UNISWAP,
    BALANCER,
    CURVE,
    GMX,
    GMX_MARKETS,
    AAVE,
    LST,
    LIQUITY,
    MARKET_LEGS,
    STABLE_MARKET_LEGS,
    MULTICALL3,
  } = constants;
  for (const table of [
    TOKENS,
    USDC_VARIANTS,
    UNISWAP,
    BALANCER,
    CURVE,
    GMX,
    GMX_MARKETS,
    AAVE,
    LST,
    LIQUITY,
    MARKET_LEGS,
    STABLE_MARKET_LEGS,
    MULTICALL3,
    FLASH_ARB_ADDRESS,
  ]) {
    collectAddresses(table, set);
  }
  cachedCoreWhitelist = set;
  return set;
}

export type WhitelistCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

function decodeSpender(data: string, wordIndex: number): string | null {
  const start = 10 + wordIndex * 64;
  const word = data.slice(start, start + 64);
  if (word.length !== 64) return null;
  const candidate = `0x${word.slice(24)}`.toLowerCase();
  return ADDRESS_RE.test(candidate) ? candidate : null;
}

function checkRawTx(
  tx: RawTx,
  known: ReadonlySet<string>,
  verifiedRegistry: ReadonlySet<string>,
): WhitelistCheckResult {
  if (!tx.to || !ADDRESS_RE.test(tx.to)) {
    return {
      ok: false,
      reason: "rawTx destination missing or malformed",
    };
  }
  const to = tx.to.toLowerCase();
  const isCore = known.has(to);
  const isVerifiedReg = verifiedRegistry.has(to);
  if (!isCore && !isVerifiedReg) {
    return {
      ok: false,
      reason: `rawTx destination ${tx.to} is not in whitelist`,
    };
  }
  if (tx.value !== undefined && BigInt(tx.value) > 0n && !isCore) {
    return {
      ok: false,
      reason: `rawTx attempts to send ETH value to non-core address ${tx.to}`,
    };
  }
  const data = tx.data ?? "0x";
  const selector = data.slice(0, 10).toLowerCase();
  const forbidden = FORBIDDEN_SELECTORS[selector];
  if (forbidden) {
    return {
      ok: false,
      reason: `rawTx calls forbidden selector ${forbidden}() on ${tx.to}`,
    };
  }
  const approval = APPROVAL_SELECTORS[selector];
  if (approval) {
    const spender = decodeSpender(data, approval.spenderWord);
    if (!spender || (!known.has(spender) && !verifiedRegistry.has(spender))) {
      return {
        ok: false,
        reason: `rawTx ${approval.name}() spender ${spender ?? "invalid"} is not whitelisted`,
      };
    }
  }
  return { ok: true };
}

export function verifyActionWhitelist(
  action: AgentAction,
  obs: AgentObservation | null,
  extraKnown?: Iterable<string>,
): WhitelistCheckResult {
  const core = new Set<string>(buildCoreWhitelist());
  if (extraKnown) {
    for (const addr of extraKnown) {
      if (ADDRESS_RE.test(addr)) core.add(addr.toLowerCase());
    }
  }
  const verifiedRegistry = new Set<string>();
  if (obs?.registry) {
    if (ADDRESS_RE.test(obs.registry.address)) {
      core.add(obs.registry.address.toLowerCase());
    }
    for (const entry of obs.registry.entries) {
      if (entry.verified && ADDRESS_RE.test(entry.market)) {
        verifiedRegistry.add(entry.market.toLowerCase());
      }
    }
  }

  if (action.type === "rawTx") {
    return checkRawTx(action.tx, core, verifiedRegistry);
  }
  if (action.type === "rawBundle") {
    for (const tx of action.txs) {
      const res = checkRawTx(tx, core, verifiedRegistry);
      if (!res.ok) return res;
    }
    return { ok: true };
  }
  if (action.type === "bundle") {
    for (const sub of action.actions) {
      const res = verifyActionWhitelist(sub as AgentAction, obs, core);
      if (!res.ok) return res;
    }
    return { ok: true };
  }
  if (!TYPED_ACTIONS.has(action.type)) {
    return {
      ok: false,
      reason: `unrecognized action type ${String((action as { type?: unknown }).type)}`,
    };
  }
  return { ok: true };
}
