// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/log.ts), modified for Ada.

export type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

const REDACTED_KEYS = /token|secret|key|password|signature|authorization|text/i;

/** Redacts anything that could carry credentials or the user's own text. */
export function redact(fields: Record<string, unknown> = {}) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      REDACTED_KEYS.test(key) ? "[redacted]" : value,
    ]),
  );
}

/** JSON-lines logger on stderr, which the parent that forked the helper reads. */
export function createLogger(
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const log = (level: string) => (event: string, fields?: Record<string, unknown>) =>
    write(JSON.stringify({ at: new Date().toISOString(), level, event, ...redact(fields) }));
  return { info: log("info"), warn: log("warn"), error: log("error") };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
