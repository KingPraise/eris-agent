import fs from 'node:fs';
import { execSync } from 'node:child_process';

// 1. Process check
try {
  const pids = execSync('powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"').toString().trim().split(/\s+/);
  console.log('Running Node PIDs:', pids);
  for (const pid of pids) {
    if (!pid) continue;
    try {
      const cmd = execSync(`powershell -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine"`).toString();
      if (cmd.includes('bot.ts') || cmd.includes('start-live-trial.ps1')) {
        console.log(`Killing lingering process ${pid}: ${cmd.slice(0, 80)}...`);
        execSync(`powershell -Command "Stop-Process -Id ${pid} -Force"`);
      }
    } catch {}
  }
} catch (e) {
  console.log('Process check err:', e.message);
}

// 2. Read log file
const logPath = 'runs/trial-live/agents/dynasty-alpha.jsonl';
if (!fs.existsSync(logPath)) {
  console.log('No log file found at', logPath);
  process.exit(0);
}

const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
console.log(`Total log entries: ${lines.length}`);

const entries = lines.map((l, i) => {
  try {
    return JSON.parse(l);
  } catch (e) {
    console.error(`Error parsing line ${i}:`, e.message);
    return null;
  }
}).filter(Boolean);

console.log('\n--- OBSERVATION & SUBMISSION SUMMARY ---');
let actionsCount = 0;
let submitsCount = 0;
let revertsCount = 0;
let successesCount = 0;

const feeTable = [];

for (const entry of entries) {
  const round = entry.blockSeen ?? entry.block ?? entry.round;
  const event = entry.event;
  const action = entry.action;
  const error = entry.error ?? entry.reason;
  const receipt = entry.receipt;

  if (action || event) {
    actionsCount++;
    const maxPrioWei = action?.maxPriorityFeePerGasWei ?? action?.priorityFee ?? entry.action?.maxPriorityFeePerGasWei;
    const prioGwei = maxPrioWei !== undefined ? (Number(BigInt(maxPrioWei)) / 1e9).toFixed(4) : 'N/A';
    const compPrioWei = entry.competition?.maxCompetitorPriorityFeeWei ?? entry.obs?.competition?.maxCompetitorPriorityFeeWei;
    const compPrioGwei = compPrioWei !== undefined ? (Number(BigInt(compPrioWei)) / 1e9).toFixed(4) : 'N/A';

    feeTable.push({
      round,
      event: event || 'action',
      type: action?.type || entry.actionType || 'N/A',
      prioGwei,
      compPrioGwei,
      status: receipt?.status === 1 ? 'SUCCESS' : receipt?.status === 0 ? 'REVERTED' : (error ? `ERR: ${String(error).slice(0, 30)}` : 'SUBMITTED')
    });
  }
}

console.log(`Total events/actions: ${actionsCount}`);
console.log(JSON.stringify(feeTable, null, 2));

// 3. Check live RPC wallet balance
const envLines = fs.readFileSync('.env', 'utf8').split('\n');
const env = {};
for (const l of envLines) {
  const m = l.match(/^([^=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}

async function checkBalance() {
  const rpcUrl = env.RPC_URL || 'https://ascon-rpc.nyx.foundation/';
  const address = env.AGENT_ADDRESS || '0xe40DA7Ac0ca9c21fe19527d31977184f0a82e6e2';
  const headers = {
    'Content-Type': 'application/json',
    'CF-Access-Client-Id': env.CF_ID,
    'CF-Access-Client-Secret': env.CF_SECRET,
    'X-ASCON-Key': env.ASCON_KEY
  };

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [address, 'latest']
      })
    });
    const data = await res.json();
    const ethBalance = Number(BigInt(data.result)) / 1e18;
    console.log(`\nCurrent On-Chain Wallet Balance (${address}): ${ethBalance.toFixed(6)} ETH`);
  } catch (e) {
    console.log('Balance check error:', e.message);
  }
}

checkBalance();
