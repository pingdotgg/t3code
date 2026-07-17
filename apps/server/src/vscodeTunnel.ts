import { type ServerVSCodeTunnel, type ServerVSCodeTunnelStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "./processRunner.ts";
import * as ServerSettings from "./serverSettings.ts";

const VSCODE_TUNNEL_STATUS_TIMEOUT = Duration.millis(1_500);
const VSCODE_TUNNEL_REFRESH_INTERVAL = Duration.minutes(1);

const VSCodeTunnelStatusJson = Schema.Struct({
  tunnel: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        tunnel: Schema.optional(Schema.String),
      }),
    ),
  ),
  service_installed: Schema.optional(Schema.Boolean),
});

const decodeVSCodeTunnelStatusJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(VSCodeTunnelStatusJson),
);

function extractVSCodeTunnelStatusJson(stdout: string): string {
  const trimmed = stdout.trim();
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const candidates: Array<string> = [];

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === undefined) break;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"' && depth > 0) {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}") {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(trimmed.slice(start, index + 1));
        start = -1;
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (Object.prototype.hasOwnProperty.call(parsed, "tunnel") ||
          Object.prototype.hasOwnProperty.call(parsed, "service_installed"))
      ) {
        return candidate;
      }
    } catch {
      // Ignore invalid JSON fragments and continue scanning.
    }
  }

  return "";
}

const UNCHECKED_STATUS: ServerVSCodeTunnelStatus = {
  checked: false,
  connected: false,
  machineName: null,
  serviceInstalled: null,
};

const CHECKED_UNAVAILABLE_STATUS: ServerVSCodeTunnelStatus = {
  checked: true,
  connected: false,
  machineName: null,
  serviceInstalled: null,
};

export interface ResolvedVSCodeTunnel {
  readonly tunnel: ServerVSCodeTunnel | null;
  readonly status: ServerVSCodeTunnelStatus;
}

export const resolveVSCodeTunnel = Effect.fn("vscodeTunnel.resolve")(function* (input: {
  readonly enabled: boolean;
}) {
  if (!input.enabled) {
    return {
      tunnel: null,
      status: UNCHECKED_STATUS,
    } satisfies ResolvedVSCodeTunnel;
  }

  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner
    .run({
      command: "code",
      args: ["tunnel", "status"],
      timeout: VSCODE_TUNNEL_STATUS_TIMEOUT,
      maxOutputBytes: 16 * 1024,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);

  if (Option.isNone(result)) {
    return {
      tunnel: null,
      status: CHECKED_UNAVAILABLE_STATUS,
    } satisfies ResolvedVSCodeTunnel;
  }
  const output = result.value;
  if (output.timedOut || output.code !== 0) {
    return {
      tunnel: null,
      status: CHECKED_UNAVAILABLE_STATUS,
    } satisfies ResolvedVSCodeTunnel;
  }

  const decoded = decodeVSCodeTunnelStatusJson(extractVSCodeTunnelStatusJson(output.stdout));
  if (Option.isNone(decoded)) {
    return {
      tunnel: null,
      status: CHECKED_UNAVAILABLE_STATUS,
    } satisfies ResolvedVSCodeTunnel;
  }
  const tunnel = decoded.value.tunnel;
  const machineName = tunnel?.name?.trim() ?? "";
  const connected = Boolean(machineName) && tunnel?.tunnel?.toLowerCase() === "connected";
  const status: ServerVSCodeTunnelStatus = {
    checked: true,
    connected,
    machineName: machineName || null,
    serviceInstalled: decoded.value.service_installed ?? null,
  };

  if (!connected) {
    return {
      tunnel: null,
      status,
    } satisfies ResolvedVSCodeTunnel;
  }

  return {
    tunnel: {
      machineName,
    },
    status,
  } satisfies ResolvedVSCodeTunnel;
});

interface CachedVSCodeTunnel {
  readonly enabled: boolean;
  readonly resolved: ResolvedVSCodeTunnel;
}

export interface VSCodeTunnelMonitorShape {
  readonly getSnapshot: (input: {
    readonly enabled: boolean;
  }) => Effect.Effect<ResolvedVSCodeTunnel>;
  readonly streamChanges: Stream.Stream<ResolvedVSCodeTunnel>;
}

export class VSCodeTunnelMonitor extends Context.Service<
  VSCodeTunnelMonitor,
  VSCodeTunnelMonitorShape
>()("t3/vscodeTunnel/VSCodeTunnelMonitor") {}

const makeVSCodeTunnelMonitor = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const cachedRef = yield* Ref.make<CachedVSCodeTunnel | null>(null);
  const changesPubSub = yield* PubSub.unbounded<ResolvedVSCodeTunnel>();
  const refreshSemaphore = yield* Semaphore.make(1);

  const refresh = Effect.fn("VSCodeTunnelMonitor.refresh")(function* (input: {
    readonly enabled: boolean;
    readonly force: boolean;
  }) {
    return yield* refreshSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const cached = yield* Ref.get(cachedRef);
        if (!input.force && cached?.enabled === input.enabled) {
          return cached.resolved;
        }

        const resolved = yield* resolveVSCodeTunnel({ enabled: input.enabled }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        );
        yield* Ref.set(cachedRef, { enabled: input.enabled, resolved });
        yield* PubSub.publish(changesPubSub, resolved);
        return resolved;
      }),
    );
  });

  const refreshFromCurrentSettings = (force: boolean) =>
    serverSettings.getSettings.pipe(
      Effect.flatMap((settings) =>
        refresh({
          enabled: settings.enableVSCodeRemoteTunnels,
          force,
        }),
      ),
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to refresh VS Code tunnel status", { cause }),
      ),
    );

  const settingsRefreshes = serverSettings.streamChanges.pipe(
    Stream.mapEffect((settings) =>
      refresh({
        enabled: settings.enableVSCodeRemoteTunnels,
        force: false,
      }),
    ),
  );
  const periodicRefreshes = Stream.tick(VSCODE_TUNNEL_REFRESH_INTERVAL).pipe(
    Stream.mapEffect(() => refreshFromCurrentSettings(true)),
  );

  yield* settingsRefreshes.pipe(
    Stream.merge(periodicRefreshes),
    Stream.runDrain,
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped({ startImmediately: true }),
  );

  return VSCodeTunnelMonitor.of({
    getSnapshot: ({ enabled }) => refresh({ enabled, force: false }),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  });
});

export const monitorLayer = Layer.effect(VSCodeTunnelMonitor, makeVSCodeTunnelMonitor);
