import packageJson from "../../package.json" with { type: "json" };
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

// Loading node-pty is part of the proof: npm can skip its native build and
// still exit 0, leaving a runtime that boots but cannot open terminals.
export async function runServicePreflight(
  input: {
    /** Older servers always pass this flag when invoking a staged preflight. */
    readonly databasePath: string;
    readonly launcherProtocol: number;
    readonly version?: string;
  },
  loadNodePty: () => Promise<unknown> = () => import("node-pty"),
): Promise<ServicePreflightResult> {
  const version = input.version ?? packageJson.version;
  if (input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL) {
    return {
      status: "blocked",
      version,
      reason:
        "This release requires a newer T3 Code service launcher. Update it on the server machine.",
    };
  }
  try {
    await loadNodePty();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      status: "blocked",
      version,
      reason: `node-pty's native binary is missing from this runtime (${detail}). On Linux it compiles during install; check that npm was allowed to run install scripts and that build tools are present.`,
    };
  }

  return { status: "ready", version, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL };
}

export function decodeServicePreflightResult(value: unknown): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === SERVICE_LAUNCHER_PROTOCOL &&
    typeof record.version === "string"
  ) {
    return {
      status: "ready",
      version: record.version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}
