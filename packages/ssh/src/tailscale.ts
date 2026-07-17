import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import {
  DEFAULT_TAILSCALE_SERVE_PORT,
  buildTailscaleHttpsBaseUrl,
  parseTailscaleStatus,
  type TailscaleStatus,
  TailscaleStatusParseError,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { SshAuthOptions } from "./auth.ts";
import { runSshCommand } from "./command.ts";
import { SshCommandError, SshInvalidTargetError } from "./errors.ts";

const REMOTE_TAILSCALE_TIMEOUT_MS = 15_000;

export const REMOTE_TAILSCALE_STATUS_SCRIPT = `set -eu
if ! command -v tailscale >/dev/null 2>&1; then
  printf '%s\n' 'T3_REMOTE_TAILSCALE_NOT_FOUND' >&2
  exit 127
fi
exec tailscale status --json
`;

export const REMOTE_TAILSCALE_SERVE_SCRIPT = `set -eu
local_port="$1"
serve_port="$2"
case "$local_port:$serve_port" in
  *[!0-9:]*|:*|*:)
    printf '%s\n' 'Invalid Tailscale Serve port.' >&2
    exit 2
    ;;
esac
if ! command -v tailscale >/dev/null 2>&1; then
  printf '%s\n' 'T3_REMOTE_TAILSCALE_NOT_FOUND' >&2
  exit 127
fi
exec tailscale serve --bg "--https=$serve_port" "http://127.0.0.1:$local_port"
`;

export const REMOTE_TAILSCALE_SERVE_STATUS_SCRIPT = `set -eu
if ! command -v tailscale >/dev/null 2>&1; then
  printf '%s\n' 'T3_REMOTE_TAILSCALE_NOT_FOUND' >&2
  exit 127
fi
exec tailscale serve status --json
`;

export class RemoteTailscaleUnavailableError extends Schema.TaggedErrorClass<RemoteTailscaleUnavailableError>()(
  "RemoteTailscaleUnavailableError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class RemoteTailscaleServeConflictError extends Schema.TaggedErrorClass<RemoteTailscaleServeConflictError>()(
  "RemoteTailscaleServeConflictError",
  {
    servePort: Schema.Number,
  },
) {
  override get message(): string {
    return `Tailscale Serve HTTPS port ${this.servePort} already has a different handler on the remote machine.`;
  }
}

const isRemoteTailscaleServeConflictError = Schema.is(RemoteTailscaleServeConflictError);

export interface RemoteTailscaleEndpoint {
  readonly status: TailscaleStatus;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly servePort: number;
}

export type RemoteTailscaleServePortState = "available" | "configured";

function normalizedProxyTarget(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function valueContainsString(value: unknown, expected: string): boolean {
  if (typeof value === "string") {
    return normalizedProxyTarget(value) === normalizedProxyTarget(expected);
  }
  if (Array.isArray(value)) return value.some((entry) => valueContainsString(entry, expected));
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some((entry) => valueContainsString(entry, expected));
}

function keyMatchesServePort(key: string, servePort: number): boolean {
  return key === String(servePort) || key.endsWith(`:${servePort}`);
}

function valueHasServePort(value: unknown, servePort: number): boolean {
  if (Array.isArray(value)) return value.some((entry) => valueHasServePort(entry, servePort));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, entry]) => keyMatchesServePort(key, servePort) || valueHasServePort(entry, servePort),
  );
}

export function inspectRemoteTailscaleServeStatus(input: {
  readonly rawStatusJson: string;
  readonly localPort: number;
  readonly servePort: number;
}): RemoteTailscaleServePortState {
  const trimmed = input.rawStatusJson.trim();
  if (trimmed.length === 0 || trimmed === "null") return "available";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new RemoteTailscaleServeConflictError({ servePort: input.servePort });
  }
  const expectedTarget = `http://127.0.0.1:${input.localPort}`;
  if (valueContainsString(parsed, expectedTarget)) return "configured";
  if (valueHasServePort(parsed, input.servePort)) {
    throw new RemoteTailscaleServeConflictError({ servePort: input.servePort });
  }
  return "available";
}

function sshAuthInput(input?: SshAuthOptions) {
  return {
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  };
}

export const discoverRemoteTailscale = Effect.fn("ssh/tailscale.discoverRemoteTailscale")(
  function* (
    target: DesktopSshEnvironmentTarget,
    input?: SshAuthOptions,
  ): Effect.fn.Return<
    TailscaleStatus,
    | SshCommandError
    | SshInvalidTargetError
    | TailscaleStatusParseError
    | RemoteTailscaleUnavailableError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-s"],
      stdin: REMOTE_TAILSCALE_STATUS_SCRIPT,
      timeoutMs: REMOTE_TAILSCALE_TIMEOUT_MS,
      ...sshAuthInput(input),
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SshCommandError && cause.stderr.includes("T3_REMOTE_TAILSCALE_NOT_FOUND")
          ? new RemoteTailscaleUnavailableError({
              message: "Tailscale is not installed on the remote machine.",
              cause,
            })
          : cause,
      ),
    );
    return yield* parseTailscaleStatus(result.stdout);
  },
);

export function remoteTailscaleEndpoint(
  status: TailscaleStatus,
  servePort = DEFAULT_TAILSCALE_SERVE_PORT,
): RemoteTailscaleEndpoint | null {
  if (status.magicDnsName === null) {
    return null;
  }
  const httpBaseUrl = buildTailscaleHttpsBaseUrl({
    magicDnsName: status.magicDnsName,
    servePort,
  });
  const wsUrl = new URL(httpBaseUrl);
  wsUrl.protocol = "wss:";
  return { status, httpBaseUrl, wsBaseUrl: wsUrl.toString(), servePort };
}

export const ensureRemoteTailscaleServe = Effect.fn("ssh/tailscale.ensureRemoteTailscaleServe")(
  function* (
    target: DesktopSshEnvironmentTarget,
    input: {
      readonly localPort: number;
      readonly servePort?: number;
      readonly auth?: SshAuthOptions;
    },
  ): Effect.fn.Return<
    RemoteTailscaleEndpoint,
    | SshCommandError
    | SshInvalidTargetError
    | TailscaleStatusParseError
    | RemoteTailscaleUnavailableError
    | RemoteTailscaleServeConflictError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    const status = yield* discoverRemoteTailscale(target, input.auth);
    const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
    const endpoint = remoteTailscaleEndpoint(status, servePort);
    if (endpoint === null) {
      return yield* new RemoteTailscaleUnavailableError({
        message: "The remote machine has no Tailscale MagicDNS name.",
      });
    }
    const serveStatus = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-s"],
      stdin: REMOTE_TAILSCALE_SERVE_STATUS_SCRIPT,
      timeoutMs: REMOTE_TAILSCALE_TIMEOUT_MS,
      ...sshAuthInput(input.auth),
    });
    const portState = yield* Effect.try({
      try: () =>
        inspectRemoteTailscaleServeStatus({
          rawStatusJson: serveStatus.stdout,
          localPort: input.localPort,
          servePort,
        }),
      catch: (cause) =>
        isRemoteTailscaleServeConflictError(cause)
          ? cause
          : new RemoteTailscaleServeConflictError({ servePort }),
    });
    if (portState === "available") {
      yield* runSshCommand(target, {
        remoteCommandArgs: ["sh", "-s", "--", String(input.localPort), String(servePort)],
        stdin: REMOTE_TAILSCALE_SERVE_SCRIPT,
        timeoutMs: REMOTE_TAILSCALE_TIMEOUT_MS,
        ...sshAuthInput(input.auth),
      });
    }
    return endpoint;
  },
);
