import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PARAMS,
  type Tuning,
  validateParams,
} from "../StrategyTuning.js";

const AGENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SHIPPED_PARAMS_PATH = join(AGENT_DIR, "strategy-params.json");

export function resolveParamsPath(): string {
  const explicit = process.env.ERIS_PARAMS_FILE;
  if (explicit && explicit.trim() !== "") return explicit;
  const stateDir = process.env.ERIS_AGENT_STATE_DIR;
  if (stateDir && stateDir.trim() !== "") {
    const stateCandidate = join(stateDir, "strategy-params.json");
    if (existsSync(stateCandidate)) return stateCandidate;
  }
  return SHIPPED_PARAMS_PATH;
}

export class ParamsLoader {
  private lastPath: string | null = null;
  private lastMtimeMs = -1;
  private current: Tuning = DEFAULT_PARAMS;
  private lastError: string | null = null;

  load(overridePath?: string): {
    params: Tuning;
    reloaded: boolean;
    error: string | null;
  } {
    const path = overridePath ?? resolveParamsPath();
    try {
      if (!existsSync(path)) {
        return { params: this.current, reloaded: false, error: null };
      }
      const st = statSync(path);
      if (this.lastPath === path && st.mtimeMs === this.lastMtimeMs) {
        return { params: this.current, reloaded: false, error: this.lastError };
      }
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const checked = validateParams(raw);
      this.lastPath = path;
      this.lastMtimeMs = st.mtimeMs;
      if (!checked.ok) {
        this.lastError = checked.reason;
        return { params: this.current, reloaded: false, error: checked.reason };
      }
      this.current = checked.params;
      this.lastError = null;
      return { params: this.current, reloaded: true, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      return { params: this.current, reloaded: false, error: msg };
    }
  }

  getCurrent(): Tuning {
    return this.current;
  }
}
