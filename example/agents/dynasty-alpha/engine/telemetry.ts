import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RegimeId } from "../StrategyTuning.js";

const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MiB per file

export type TelemetryRecord = {
  ts: string;
  round: number;
  blocksRemaining?: number;
  regime: RegimeId;
  module: "ammArb" | "pegArb" | "liquidation" | "none";
  actionType: string;
  reason: string;
  expectedEdgeBps: number;
  fairPriceUsdcPerWeth: number;
  latencyMs: number;
  breakerTripped: boolean;
};

export class TelemetryLogger {
  private disabled = false;

  record(entry: TelemetryRecord): void {
    if (this.disabled) return;
    const stateDir = process.env.ERIS_AGENT_STATE_DIR;
    if (!stateDir || stateDir.trim() === "") return;
    try {
      const telemetryDir = join(stateDir, "telemetry");
      if (!existsSync(telemetryDir)) {
        mkdirSync(telemetryDir, { recursive: true });
      }
      const epochTag = process.env.ERIS_RUN_ID ?? "epoch";
      const safeTag = epochTag.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = join(telemetryDir, `telemetry-${safeTag}.jsonl`);
      if (existsSync(filePath)) {
        const st = statSync(filePath);
        if (st.size >= MAX_FILE_BYTES) {
          this.disabled = true;
          return;
        }
      }
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      this.disabled = true;
    }
  }
}
