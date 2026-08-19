/**
 * Parses `vp run dev` stdout for ports and the one-time pairing URL.
 * Pairing tokens must never be logged or embedded in assertion messages.
 */

const ANSI_ESCAPE = /\u001B\[[0-9;]*m/g;
const DEV_RUNNER_LINE =
  /\[dev-runner\] mode=\S+ source=.+? serverPort=(\d+) webPort=(\d+) baseDir=(\S+)/;
const PAIRING_URL = /https?:\/\/[^\s"'\\]+\/pair#token=[^\s"'\\]+/i;
const PAIRING_TOKEN_FRAGMENT = /(#token=)[^\s"'\\]+/gi;

export interface DevRunnerPorts {
  readonly serverPort: number;
  readonly webPort: number;
  readonly baseDir: string;
}

export function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_ESCAPE, "");
}

export function redactSecrets(text: string): string {
  return stripAnsi(text).replaceAll(PAIRING_TOKEN_FRAGMENT, "$1REDACTED");
}

export function parseDevRunnerLine(output: string): DevRunnerPorts | null {
  const match = DEV_RUNNER_LINE.exec(stripAnsi(output));
  if (match === null) {
    return null;
  }
  return {
    serverPort: Number(match[1]),
    webPort: Number(match[2]),
    baseDir: match[3] ?? "",
  };
}

export function parsePairingUrl(output: string): string | null {
  const match = PAIRING_URL.exec(stripAnsi(output));
  return match?.[0] ?? null;
}

export function webOrigin(webPort: number): string {
  return `http://localhost:${webPort}`;
}
