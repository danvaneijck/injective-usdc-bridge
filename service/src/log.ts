type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** One JSON object per line on stdout. bigint is written as a string. */
export function createLogger(level: Level = "info", base: Record<string, unknown> = {}): Logger {
  const emit = (l: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[l] < ORDER[level]) return;
    const line = JSON.stringify(
      { t: new Date().toISOString(), level: l, msg, ...base, ...fields },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    (l === "error" || l === "warn" ? console.error : console.log)(line);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (f) => createLogger(level, { ...base, ...f }),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};
