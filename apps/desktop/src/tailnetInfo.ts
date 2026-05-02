import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TAILSCALE_COMMAND = "tailscale";

export interface TailnetInfo {
  readonly available: boolean;
  readonly connected: boolean;
  readonly hostname: string | null;
  readonly ipv4: string | null;
  readonly error: string | null;
}

const UNAVAILABLE: TailnetInfo = {
  available: false,
  connected: false,
  hostname: null,
  ipv4: null,
  error: null,
};

interface TailscaleStatus {
  readonly BackendState?: string;
  readonly Self?: {
    readonly DNSName?: string;
    readonly Online?: boolean;
    readonly TailscaleIPs?: readonly string[];
  };
}

function normalizeDnsName(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\.$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

function pickIpv4(ips: readonly string[] | undefined): string | null {
  if (!ips || ips.length === 0) return null;
  for (const ip of ips) {
    if (ip.includes(".") && !ip.includes(":")) {
      return ip;
    }
  }
  return null;
}

function isCommandNotFound(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const message = String((cause as { message?: unknown }).message ?? "");
  if (/ENOENT|not found|no such file/i.test(message)) return true;
  const code = (cause as { code?: unknown }).code;
  return code === "ENOENT";
}

async function runTailscale(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(TAILSCALE_COMMAND, [...args], {
    timeout: 5_000,
  });
  return stdout;
}

export async function readTailnetInfo(
  runCommand: (args: readonly string[]) => Promise<string> = runTailscale,
): Promise<TailnetInfo> {
  let raw: string;
  try {
    raw = await runCommand(["status", "--json"]);
  } catch (cause) {
    if (isCommandNotFound(cause)) {
      return UNAVAILABLE;
    }
    return {
      available: true,
      connected: false,
      hostname: null,
      ipv4: null,
      error: `tailscale status failed: ${String(cause)}`,
    };
  }

  let parsed: TailscaleStatus;
  try {
    parsed = JSON.parse(raw) as TailscaleStatus;
  } catch (cause) {
    return {
      available: true,
      connected: false,
      hostname: null,
      ipv4: null,
      error: `tailscale status returned unparseable JSON: ${String(cause)}`,
    };
  }

  const connected =
    parsed.BackendState === "Running" ||
    Boolean(parsed.Self?.Online && (parsed.Self.TailscaleIPs?.length ?? 0) > 0);

  return {
    available: true,
    connected,
    hostname: normalizeDnsName(parsed.Self?.DNSName),
    ipv4: pickIpv4(parsed.Self?.TailscaleIPs),
    error: null,
  };
}
