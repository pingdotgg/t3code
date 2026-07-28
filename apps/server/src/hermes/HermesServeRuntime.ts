import * as NodeNet from "node:net";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HermesGatewayClient } from "./HermesGatewayClient.ts";

export const DEFAULT_HERMES_SERVE_ENDPOINT = "ws://127.0.0.1:9119/api/ws";

export type HermesServeOwnership = "external" | "t3_owned";

export interface HermesServeConnection {
  readonly endpoint: string;
  readonly authToken: string;
  readonly ownership: HermesServeOwnership;
}

export interface HermesServeRuntimeShape {
  readonly effectiveEndpoint: string;
  readonly ensureReady: Effect.Effect<HermesServeConnection, HermesServeRuntimeError>;
  readonly currentOwnership: () => HermesServeOwnership | null;
}

interface HermesOwnedProcessHandle {
  readonly isRunning: Effect.Effect<boolean, HermesOwnedProcessError>;
  readonly kill: () => Effect.Effect<void, HermesOwnedProcessError>;
}

class HermesOwnedProcessError extends Schema.TaggedErrorClass<HermesOwnedProcessError>()(
  "HermesOwnedProcessError",
  {
    cause: Schema.Defect(),
  },
) {}

export class HermesServeRuntimeError extends Schema.TaggedErrorClass<HermesServeRuntimeError>()(
  "HermesServeRuntimeError",
  {
    code: Schema.Literals([
      "authentication_required",
      "endpoint_in_use",
      "managed_start_disabled",
      "managed_start_failed",
      "remote_unreachable",
      "unreachable",
    ]),
    message: Schema.String,
  },
) {}

class HermesServeProbeError extends Schema.TaggedErrorClass<HermesServeProbeError>()(
  "HermesServeProbeError",
  {
    cause: Schema.Defect(),
  },
) {}

export interface MakeHermesServeRuntimeOptions {
  readonly endpoint: string;
  readonly authToken: string | undefined;
  readonly managedServerEnabled: boolean;
  readonly processEnvironment: NodeJS.ProcessEnv;
  readonly probe?: (input: {
    readonly endpoint: string;
    readonly authToken: string;
  }) => Promise<void>;
  readonly endpointReachable?: (endpoint: string) => Promise<boolean>;
  readonly start?: (input: {
    readonly host: string;
    readonly port: number;
    readonly authToken: string;
  }) => Effect.Effect<HermesOwnedProcessHandle, HermesOwnedProcessError>;
  readonly startupAttempts?: number;
  readonly startupPollInterval?: Duration.Input;
}

export function resolveHermesServeEndpoint(endpoint: string): string {
  return endpoint.trim() || DEFAULT_HERMES_SERVE_ENDPOINT;
}

function localServeTarget(
  endpoint: string,
): { readonly host: string; readonly port: number } | null {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "ws:") return null;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) return null;
    const port = parsed.port ? Number(parsed.port) : 80;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
    return { host: parsed.hostname === "[::1]" ? "::1" : parsed.hostname, port };
  } catch {
    return null;
  }
}

async function defaultEndpointReachable(endpoint: string): Promise<boolean> {
  const target = localServeTarget(endpoint);
  if (target === null) return false;
  return new Promise((resolve) => {
    const socket = NodeNet.createConnection(target);
    const finish = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(1_500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function defaultProbe(input: {
  readonly endpoint: string;
  readonly authToken: string;
}): Promise<void> {
  const client = new HermesGatewayClient({
    endpoint: input.endpoint,
    authToken: input.authToken,
    reconnect: { maxAttempts: 0 },
  });
  try {
    await client.connect();
  } finally {
    client.close();
  }
}

export const makeHermesServeRuntime = Effect.fn("makeHermesServeRuntime")(function* (
  options: MakeHermesServeRuntimeOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ownerScope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  const effectiveEndpoint = resolveHermesServeEndpoint(options.endpoint);
  const probe = options.probe ?? defaultProbe;
  const endpointReachable = options.endpointReachable ?? defaultEndpointReachable;
  const startupAttempts = options.startupAttempts ?? 80;
  const startupPollInterval = options.startupPollInterval ?? "150 millis";
  let connection: HermesServeConnection | null = null;
  let ownedProcess: HermesOwnedProcessHandle | null = null;

  const probeEffect = (authToken: string) =>
    Effect.tryPromise({
      try: () => probe({ endpoint: effectiveEndpoint, authToken }),
      catch: (cause) => new HermesServeProbeError({ cause }),
    });

  const start =
    options.start ??
    ((input: { readonly host: string; readonly port: number; readonly authToken: string }) =>
      spawner
        .spawn(
          ChildProcess.make(
            "hermes",
            ["serve", "--host", input.host, "--port", String(input.port)],
            {
              env: {
                ...options.processEnvironment,
                HERMES_DASHBOARD_SESSION_TOKEN: input.authToken,
              },
              extendEnv: false,
              detached: false,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              forceKillAfter: "5 seconds",
            },
          ),
        )
        .pipe(
          Effect.provideService(Scope.Scope, ownerScope),
          Effect.mapError((cause) => new HermesOwnedProcessError({ cause })),
          Effect.map((handle) => ({
            isRunning: handle.isRunning.pipe(
              Effect.mapError((cause) => new HermesOwnedProcessError({ cause })),
            ),
            kill: () =>
              handle
                .kill({ forceKillAfter: "5 seconds" })
                .pipe(Effect.mapError((cause) => new HermesOwnedProcessError({ cause }))),
          })),
        ));

  const stopOwnedProcess = Effect.fn("HermesServeRuntime.stopOwnedProcess")(function* () {
    const handle = ownedProcess;
    ownedProcess = null;
    if (handle !== null) {
      yield* handle.kill().pipe(Effect.orElseSucceed(() => undefined));
    }
  });

  yield* Effect.addFinalizer(() =>
    mutex.withPermit(
      Effect.gen(function* () {
        connection = null;
        yield* stopOwnedProcess();
      }),
    ),
  );

  const ensureReady = mutex.withPermit(
    Effect.gen(function* () {
      const authToken = options.authToken?.trim();
      if (!authToken) {
        return yield* new HermesServeRuntimeError({
          code: "authentication_required",
          message:
            "Hermes requires a gateway token. Add HERMES_GATEWAY_TOKEN in T3 Work so T3 can attach to or launch Hermes Serve securely.",
        });
      }

      if (connection !== null) {
        const cachedProbe = yield* Effect.result(probeEffect(authToken));
        if (cachedProbe._tag === "Success") return connection;
        connection = null;
        if (ownedProcess !== null) {
          const stillRunning = yield* ownedProcess.isRunning.pipe(
            Effect.orElseSucceed(() => false),
          );
          if (!stillRunning) ownedProcess = null;
        }
      }

      const attachProbe = yield* Effect.result(probeEffect(authToken));
      if (attachProbe._tag === "Success") {
        connection = {
          endpoint: effectiveEndpoint,
          authToken,
          ownership: ownedProcess === null ? "external" : "t3_owned",
        };
        return connection;
      }

      const reachable = yield* Effect.promise(() =>
        endpointReachable(effectiveEndpoint).catch(() => false),
      );
      if (reachable) {
        // A listener that T3 itself launched is not a conflicting external
        // instance; stop the unhealthy owned process and relaunch it below.
        const ownedStillRunning =
          ownedProcess === null
            ? false
            : yield* ownedProcess.isRunning.pipe(Effect.orElseSucceed(() => false));
        if (!ownedStillRunning) {
          return yield* new HermesServeRuntimeError({
            code: "endpoint_in_use",
            message:
              "A Hermes Serve instance is already running at this endpoint, but it rejected the configured gateway token or protocol handshake. Use the token from that Hermes instance, then refresh.",
          });
        }
        yield* stopOwnedProcess();
      }

      const target = localServeTarget(effectiveEndpoint);
      if (target === null) {
        return yield* new HermesServeRuntimeError({
          code: "remote_unreachable",
          message:
            "The configured Hermes gateway is unreachable. T3 only auto-starts credentialed loopback Hermes Serve instances.",
        });
      }
      if (!options.managedServerEnabled) {
        return yield* new HermesServeRuntimeError({
          code: "managed_start_disabled",
          message:
            "Hermes Serve is not reachable and automatic startup is disabled for this provider.",
        });
      }

      // A previously owned process can survive with its TCP listener
      // temporarily unreachable; always stop it before launching a
      // replacement so the old child is never orphaned.
      yield* stopOwnedProcess();

      const started = yield* Effect.result(
        start({ ...target, authToken }).pipe(
          Effect.mapError(
            () =>
              new HermesServeRuntimeError({
                code: "managed_start_failed",
                message:
                  "T3 could not launch `hermes serve`. Make sure the Hermes CLI is installed and available on PATH.",
              }),
          ),
        ),
      );
      if (started._tag === "Failure") {
        return yield* started.failure;
      }
      ownedProcess = started.success;

      for (let attempt = 0; attempt < startupAttempts; attempt += 1) {
        const ready = yield* Effect.result(probeEffect(authToken));
        if (ready._tag === "Success") {
          connection = {
            endpoint: effectiveEndpoint,
            authToken,
            ownership: "t3_owned",
          };
          return connection;
        }
        const stillRunning = yield* ownedProcess.isRunning.pipe(Effect.orElseSucceed(() => false));
        if (!stillRunning) break;
        yield* Effect.sleep(startupPollInterval);
      }

      yield* stopOwnedProcess();
      return yield* new HermesServeRuntimeError({
        code: "managed_start_failed",
        message:
          "T3 launched `hermes serve`, but the gateway did not become ready before the startup timeout.",
      });
    }),
  );

  return {
    effectiveEndpoint,
    ensureReady,
    currentOwnership: () => connection?.ownership ?? null,
  } satisfies HermesServeRuntimeShape;
});
