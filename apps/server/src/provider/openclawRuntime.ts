/**
 * openclawRuntime — shared runtime for the OpenClaw provider.
 *
 * OpenClaw is server-backed: a local **Gateway** daemon owns sessions,
 * tools, and channel connections, and every client (Control UI, CLI, TUI)
 * talks to it over a WebSocket control plane. This module owns that
 * connection for T3 Code — either by spawning a fresh gateway process for
 * this instance or by connecting to a user-configured `gatewayUrl`.
 *
 * Transport (verified against the OpenClaw docs + source):
 *
 * - WebSocket, JSON text frames. First frame MUST be `connect`; the gateway
 *   answers with a `res` carrying `hello-ok` (`server.version`,
 *   `features.methods`, `policy`, `auth`).
 *   See https://docs.openclaw.ai/gateway/protocol and
 *   https://docs.openclaw.ai/gateway/embedding
 * - Requests: `{type:"req", id, method, params}` →
 *   `{type:"res", id, ok, payload|error}`. Agent runs are two-stage: an
 *   immediate `status:"accepted"` ack, then a final completion `res` for the
 *   same id (delivered here as a synthetic `openclaw.response` event so long
 *   runs are not blocked on a single request/response round trip).
 * - Events: `{type:"event", event, payload, seq?}`. Run streaming arrives as
 *   `agent` events with `{runId, seq, stream, ts, data}` where `stream` is
 *   `lifecycle` (phase start/end/error), `assistant`, `thinking`, `tool`,
 *   `approval`, or `usage`.
 * - Auth: shared-secret `gateway.auth.token` (`OPENCLAW_GATEWAY_TOKEN`).
 *   This adapter connects as the documented same-process backend client
 *   (`client.id: "gateway-client"`, `client.mode: "backend"`), which is
 *   allowed to omit the device identity on direct loopback connections when
 *   authenticated with the shared token
 *   (https://docs.openclaw.ai/gateway/protocol#pairing-and-local-trust).
 *   ASSUMPTION: a remote gateway that enforces device pairing will reject
 *   this connect; the error surfaces as a clear `ProviderAdapterRequestError`.
 *
 * Spawning: `openclaw gateway --port <free-port> --allow-unconfigured` plus
 * the embedding environment documented at https://docs.openclaw.ai/gateway/embedding
 * (`OPENCLAW_NO_RESPAWN`, `OPENCLAW_DISABLE_BONJOUR`,
 * `OPENCLAW_EXEC_SHELL_SNAPSHOT`, `OPENCLAW_SKIP_CHANNELS`). The spawned
 * gateway gets its own token and an isolated `OPENCLAW_STATE_DIR` under the
 * T3 instance state directory so it never touches a user's `~/.openclaw`.
 *
 * @module provider/openclawRuntime
 */
import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";

const OPENCLAW_RUNTIME_ERROR_TAG = "OpenClawRuntimeError";
export class OpenClawRuntimeError extends Data.TaggedError(OPENCLAW_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenClawRuntimeError =>
    P.isTagged(u, OPENCLAW_RUNTIME_ERROR_TAG);
}

export function openClawRuntimeErrorDetail(cause: unknown): string {
  if (OpenClawRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  return String(cause);
}

export interface OpenClawCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenClawGatewayEventFrame {
  readonly event: string;
  readonly payload?: unknown;
  readonly seq?: number;
}

/** A late `res` frame for a request whose first response already resolved. */
export interface OpenClawLateResponseFrame {
  readonly id: string;
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: unknown;
}

export type OpenClawGatewayEvent =
  | { readonly kind: "event"; readonly frame: OpenClawGatewayEventFrame }
  | { readonly kind: "response"; readonly frame: OpenClawLateResponseFrame }
  | { readonly kind: "closed"; readonly reason: string };

export interface OpenClawHelloInfo {
  readonly protocol: number;
  readonly serverVersion: string;
  readonly connId: string;
  readonly methods: ReadonlyArray<string>;
  readonly events: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<string>;
}

export interface OpenClawGatewayConnection {
  readonly url: string;
  readonly hello: OpenClawHelloInfo;
  /** True when this connection is to a user-configured external gateway. */
  readonly external: boolean;
  /**
   * Shared-secret token used for this connection. Exposed so HTTP consumers
   * (the OpenAI-compatible endpoints used by text generation) can reuse the
   * same auth boundary as the WebSocket control plane.
   */
  readonly gatewayToken: string | undefined;
  /**
   * Send one RPC. Resolves on the FIRST matching response frame (the
   * `status:"accepted"` ack for agent runs); later frames for the same id
   * surface on `events` as `response` frames.
   */
  readonly request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Effect.Effect<unknown, OpenClawRuntimeError>;
  /** Inbound event frames + late response frames + close notifications. */
  readonly events: Stream.Stream<OpenClawGatewayEvent>;
  readonly close: Effect.Effect<void>;
  /** Exit code of the spawned gateway process, or null for external gateways. */
  readonly exitCode: Effect.Effect<number, never> | null;
}

export interface OpenClawRuntimeShape {
  /**
   * Resolve the gateway for this instance: connect to `gatewayUrl` when set,
   * otherwise spawn `binaryPath gateway --port <free>` and wait for protocol
   * readiness. The child process lifetime is bound to the caller's scope.
   */
  readonly connectToOpenClawGateway: (input: {
    readonly binaryPath: string;
    readonly gatewayUrl?: string;
    readonly gatewayToken?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly stateDir?: string;
    readonly launchArgs?: ReadonlyArray<string>;
    readonly port?: number;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenClawGatewayConnection, OpenClawRuntimeError, Scope.Scope>;
  readonly runOpenClawCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<OpenClawCommandResult, OpenClawRuntimeError>;
}

const DEFAULT_GATEWAY_PORT = 18_789;
const DEFAULT_GATEWAY_STARTUP_TIMEOUT_MS = 30_000;
const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const PROTOCOL_VERSION = 4;

const OPENCLAW_OPERATOR_SCOPES = ["operator.read", "operator.write", "operator.approvals"] as const;

function wsUrlForPort(port: number): string {
  return `ws://${DEFAULT_HOSTNAME}:${port}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PendingRequest {
  readonly deferred: Deferred.Deferred<
    { readonly ok: boolean; readonly payload?: unknown; readonly error?: unknown },
    OpenClawRuntimeError
  >;
}

/**
 * Minimal gateway protocol client over the platform WebSocket. Kept as a
 * plain class because it is a transport primitive; the Effect surface lives
 * on the runtime service.
 */
class OpenClawWsClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventQueue: Queue.Queue<OpenClawGatewayEvent>;
  private readonly socket: WebSocket;
  private requestSeq = 0;
  private readonly closed = new Set<string>();

  constructor(socket: WebSocket, eventQueue: Queue.Queue<OpenClawGatewayEvent>) {
    this.socket = socket;
    this.eventQueue = eventQueue;
  }

  static connect(
    url: string,
    eventQueue: Queue.Queue<OpenClawGatewayEvent>,
  ): Effect.Effect<OpenClawWsClient, OpenClawRuntimeError> {
    return Effect.tryPromise({
      try: () =>
        new Promise<OpenClawWsClient>((resolve, reject) => {
          let socket: WebSocket;
          try {
            socket = new WebSocket(url);
          } catch (cause) {
            reject(
              new OpenClawRuntimeError({
                operation: "ws.connect",
                detail: `Failed to construct WebSocket for '${url}': ${openClawRuntimeErrorDetail(cause)}`,
                cause,
              }),
            );
            return;
          }
          socket.addEventListener("open", () => {
            resolve(new OpenClawWsClient(socket, eventQueue));
          });
          socket.addEventListener("error", () => {
            const readyState = socket.readyState;
            reject(
              new OpenClawRuntimeError({
                operation: "ws.connect",
                detail:
                  readyState === WebSocket.CONNECTING
                    ? `Gateway unreachable at '${url}' (connection refused or closed during handshake).`
                    : `Gateway WebSocket errored at '${url}'.`,
              }),
            );
          });
        }),
      catch: (cause) =>
        OpenClawRuntimeError.is(cause)
          ? cause
          : new OpenClawRuntimeError({
              operation: "ws.connect",
              detail: openClawRuntimeErrorDetail(cause),
              cause,
            }),
    });
  }

  /** Register the message/close handlers that drive requests + events. */
  attach(): void {
    this.socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : undefined;
      if (raw === undefined) {
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(raw) as unknown;
      } catch {
        return;
      }
      if (!isRecord(frame)) {
        return;
      }
      const type = frame.type;
      if (type === "res") {
        this.handleResponse(frame);
        return;
      }
      if (type === "event") {
        const eventName = frame.event;
        if (typeof eventName === "string") {
          Effect.runSync(
            Queue.offer(this.eventQueue, {
              kind: "event",
              frame: {
                event: eventName,
                ...(frame.payload !== undefined ? { payload: frame.payload } : {}),
                ...(typeof frame.seq === "number" ? { seq: frame.seq } : {}),
              },
            }),
          );
        }
        return;
      }
    });
    this.socket.addEventListener("close", (event) => {
      const reason = `Gateway WebSocket closed (code ${event.code}${event.reason ? `: ${event.reason}` : ""}).`;
      Effect.runSync(Queue.offer(this.eventQueue, { kind: "closed", reason }));
      for (const pending of this.pending.values()) {
        Effect.runSync(
          Deferred.fail(
            pending.deferred,
            new OpenClawRuntimeError({ operation: "ws.close", detail: reason }),
          ),
        );
      }
      this.pending.clear();
    });
  }

  private handleResponse(frame: Record<string, unknown>): void {
    const id = frame.id;
    if (typeof id !== "string") {
      return;
    }
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      this.closed.add(id);
      const ok = frame.ok === true;
      const payload = frame.payload;
      const error = frame.error;
      Effect.runSync(
        Deferred.succeed(pending.deferred, {
          ok,
          ...(payload !== undefined ? { payload } : {}),
          ...(error !== undefined ? { error } : {}),
        }),
      );
      return;
    }
    if (this.closed.has(id)) {
      // Late second-stage response (e.g. the final agent completion).
      Effect.runSync(
        Queue.offer(this.eventQueue, {
          kind: "response",
          frame: {
            id,
            ok: frame.ok === true,
            ...(frame.payload !== undefined ? { payload: frame.payload } : {}),
            ...(frame.error !== undefined ? { error: frame.error } : {}),
          },
        }),
      );
      return;
    }
  }

  request(
    method: string,
    params?: Record<string, unknown>,
  ): Effect.Effect<
    { readonly ok: boolean; readonly payload?: unknown; readonly error?: unknown },
    OpenClawRuntimeError
  > {
    const client = this;
    return Effect.gen(function* () {
      const id = `t3-${method}-${++client.requestSeq}`;
      const deferred = yield* Deferred.make<
        { readonly ok: boolean; readonly payload?: unknown; readonly error?: unknown },
        OpenClawRuntimeError
      >();
      client.pending.set(id, { deferred });
      const frame: Record<string, unknown> = { type: "req", id, method };
      if (params !== undefined) {
        frame.params = params;
      }
      try {
        client.socket.send(JSON.stringify(frame));
      } catch (cause) {
        client.pending.delete(id);
        return yield* new OpenClawRuntimeError({
          operation: method,
          detail: `Failed to send gateway request '${method}': ${openClawRuntimeErrorDetail(cause)}`,
          cause,
        });
      }
      const timedOut = yield* Effect.timeoutOption(
        Deferred.await(deferred),
        GATEWAY_REQUEST_TIMEOUT_MS,
      );
      if (timedOut._tag === "None") {
        client.pending.delete(id);
        return yield* new OpenClawRuntimeError({
          operation: method,
          detail: `Gateway request '${method}' timed out after ${GATEWAY_REQUEST_TIMEOUT_MS}ms.`,
        });
      }
      return timedOut.value;
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

const makeOpenClawRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcessPlatform;

  const runOpenClawCommand: OpenClawRuntimeShape["runOpenClawCommand"] = (input) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveSpawnCommand(
        input.binaryPath,
        input.args,
        input.environment !== undefined ? { env: input.environment } : {},
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          shell: spawnCommand.shell,
          ...(input.environment ? { env: input.environment } : { extendEnv: true }),
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenClawRuntimeError({
          operation: "runOpenClawCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return { stdout, stderr, code: exitCode } satisfies OpenClawCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        OpenClawRuntimeError.is(cause)
          ? cause
          : new OpenClawRuntimeError({
              operation: "runOpenClawCommand",
              detail: `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openClawRuntimeErrorDetail(cause)}`,
              cause,
            }),
      ),
    );

  /**
   * Establish a WS connection + handshake against a running gateway.
   * Handles the retryable `UNAVAILABLE` (startup sidecars) connect error.
   */
  const openGatewayConnection = (input: {
    readonly url: string;
    readonly gatewayToken?: string;
    readonly external: boolean;
    readonly exitCode: Effect.Effect<number, never> | null;
  }): Effect.Effect<OpenClawGatewayConnection, OpenClawRuntimeError> =>
    Effect.gen(function* () {
      const eventQueue = yield* Queue.unbounded<OpenClawGatewayEvent>();
      const client = yield* OpenClawWsClient.connect(input.url, eventQueue);
      client.attach();

      const connectFrame: Record<string, unknown> = {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          version: "0.0.0",
          platform:
            hostPlatform === "win32" ? "win32" : hostPlatform === "darwin" ? "darwin" : "linux",
          mode: "backend",
        },
        role: "operator",
        scopes: [...OPENCLAW_OPERATOR_SCOPES],
        caps: ["tool-events"],
        ...(input.gatewayToken !== undefined && input.gatewayToken.length > 0
          ? { auth: { token: input.gatewayToken } }
          : {}),
        userAgent: "t3-code/openclaw-adapter",
      };

      const connectResult = yield* client.request("connect", connectFrame);
      if (!connectResult.ok) {
        client.close();
        return yield* new OpenClawRuntimeError({
          operation: "connect",
          detail: openClawConnectErrorDetail(connectResult.error),
          cause: connectResult.error,
        });
      }
      const hello = parseHelloInfo(connectResult.payload);
      if (!hello) {
        client.close();
        return yield* new OpenClawRuntimeError({
          operation: "connect",
          detail: "Gateway hello-ok payload was missing or malformed.",
          cause: connectResult.payload,
        });
      }

      return {
        url: input.url,
        hello,
        external: input.external,
        gatewayToken: input.gatewayToken,
        request: (method, params) =>
          client.request(method, params).pipe(
            Effect.flatMap((response) =>
              response.ok
                ? Effect.succeed(response.payload)
                : new OpenClawRuntimeError({
                    operation: method,
                    detail: openClawRpcErrorDetail(response.error),
                    cause: response.error,
                  }),
            ),
          ),
        get events() {
          return Stream.fromQueue(eventQueue);
        },
        close: Effect.sync(() => client.close()),
        exitCode: input.exitCode,
      } satisfies OpenClawGatewayConnection;
    });

  const spawnGatewayProcess = (input: {
    readonly binaryPath: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port: number;
    readonly stateDir?: string;
    readonly launchArgs?: ReadonlyArray<string>;
  }): Effect.Effect<
    { readonly exitCode: Effect.Effect<number, never>; readonly token: string },
    OpenClawRuntimeError,
    Scope.Scope
  > =>
    Effect.gen(function* () {
      const runtimeScope = yield* Scope.Scope;
      const token = NodeCrypto.randomBytes(24).toString("base64url");
      const args = [
        "gateway",
        "--port",
        String(input.port),
        "--allow-unconfigured",
        ...(input.launchArgs ?? []),
      ];
      const spawnCommand = yield* resolveSpawnCommand(
        input.binaryPath,
        args,
        input.environment !== undefined ? { env: input.environment } : {},
      );
      const environment: NodeJS.ProcessEnv = {
        ...(input.environment ?? process.env),
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_DISABLE_BONJOUR: "1",
        OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
        OPENCLAW_SKIP_CHANNELS: "1",
        ...(input.stateDir ? { OPENCLAW_STATE_DIR: input.stateDir } : {}),
      };
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            shell: spawnCommand.shell,
            env: environment,
            extendEnv: false,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new OpenClawRuntimeError({
                operation: "spawnGatewayProcess",
                detail: `Failed to spawn OpenClaw gateway process: ${openClawRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const killGatewayProcessGroup = (signal: NodeJS.Signals) =>
        hostPlatform === "win32"
          ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), signal);
              } catch {
                // The direct child may already have exited; the group kill is
                // best-effort cleanup for any gateway process left in that group.
              }
            });
      const terminateChild = killGatewayProcessGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killGatewayProcessGroup("SIGKILL")),
        Effect.ignore,
      );
      yield* Scope.addFinalizer(runtimeScope, terminateChild);

      // Watch the exit code through a Deferred: `child.exitCode` is not
      // interruptible, so awaiting it directly inside the readiness loop's
      // timeout would block until the (long-lived) gateway actually exits.
      const exitDeferred = yield* Deferred.make<number, never>();
      yield* child.exitCode.pipe(
        Effect.flatMap((code) => Deferred.succeed(exitDeferred, Number(code))),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      return {
        exitCode: Deferred.await(exitDeferred),
        token,
      };
    });

  const connectToOpenClawGateway: OpenClawRuntimeShape["connectToOpenClawGateway"] = (input) => {
    const gatewayUrl = input.gatewayUrl?.trim();
    if (gatewayUrl) {
      // External gateway: no process to own, no scope interaction.
      const token = input.gatewayToken?.trim();
      return openGatewayConnection({
        url: normalizeGatewayWsUrl(gatewayUrl),
        ...(token !== undefined && token.length > 0 ? { gatewayToken: token } : {}),
        external: true,
        exitCode: null,
      }).pipe(
        Effect.mapError((cause) =>
          OpenClawRuntimeError.is(cause)
            ? cause
            : new OpenClawRuntimeError({
                operation: "connectToOpenClawGateway",
                detail: openClawRuntimeErrorDetail(cause),
                cause,
              }),
        ),
      );
    }

    return Effect.gen(function* () {
      const timeoutMs = input.timeoutMs ?? DEFAULT_GATEWAY_STARTUP_TIMEOUT_MS;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenClawRuntimeError({
                operation: "connectToOpenClawGateway",
                detail: `Failed to find an available gateway port: ${openClawRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const spawned = yield* spawnGatewayProcess({
        binaryPath: input.binaryPath,
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
        port,
        ...(input.stateDir !== undefined ? { stateDir: input.stateDir } : {}),
        ...(input.launchArgs !== undefined ? { launchArgs: input.launchArgs } : {}),
      });
      const url = wsUrlForPort(port);

      // Wait for protocol readiness: repeatedly open the WS + handshake until
      // hello-ok arrives or the child exits (embedding readiness contract).
      const deadline = Date.now() + timeoutMs;
      let lastError: OpenClawRuntimeError | undefined;
      let exitCode: number | undefined;
      while (Date.now() < deadline) {
        const attempt = yield* Effect.exit(
          openGatewayConnection({
            url,
            gatewayToken: spawned.token,
            external: false,
            exitCode: spawned.exitCode,
          }),
        );
        if (Exit.isSuccess(attempt)) {
          return attempt.value;
        }
        const cause = Cause.squash(attempt.cause);
        lastError = OpenClawRuntimeError.is(cause) ? cause : undefined;
        const exitResult = yield* Effect.exit(
          Effect.timeoutOption(spawned.exitCode, "250 millis").pipe(
            Effect.map((result) => (result._tag === "Some" ? result.value : undefined)),
          ),
        );
        if (Exit.isSuccess(exitResult) && exitResult.value !== undefined) {
          exitCode = exitResult.value;
          break;
        }
        yield* Effect.sleep("250 millis");
      }
      if (exitCode !== undefined) {
        return yield* new OpenClawRuntimeError({
          operation: "connectToOpenClawGateway",
          detail: `OpenClaw gateway exited before becoming ready (code ${exitCode}).`,
        });
      }
      return yield* new OpenClawRuntimeError({
        operation: "connectToOpenClawGateway",
        detail: `Timed out waiting for the OpenClaw gateway to start after ${timeoutMs}ms.${lastError ? ` Last error: ${lastError.detail}` : ""}`,
        cause: lastError,
      });
    });
  };

  return {
    connectToOpenClawGateway,
    runOpenClawCommand,
  } satisfies OpenClawRuntimeShape;
});

function normalizeGatewayWsUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }
  return `ws://${trimmed}`;
}

function parseHelloInfo(payload: unknown): OpenClawHelloInfo | null {
  if (!isRecord(payload)) {
    return null;
  }
  const server = isRecord(payload.server) ? payload.server : {};
  const features = isRecord(payload.features) ? payload.features : {};
  const auth = isRecord(payload.auth) ? payload.auth : {};
  const serverVersion = typeof server.version === "string" ? server.version : "";
  const connId = typeof server.connId === "string" ? server.connId : "";
  const protocol = typeof payload.protocol === "number" ? payload.protocol : 0;
  if (serverVersion.length === 0 || protocol === 0) {
    return null;
  }
  const asStringArray = (value: unknown): ReadonlyArray<string> =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    protocol,
    serverVersion,
    connId,
    methods: asStringArray(features.methods),
    events: asStringArray(features.events),
    scopes: asStringArray(auth.scopes),
  };
}

function openClawConnectErrorDetail(error: unknown): string {
  if (isRecord(error)) {
    const code = typeof error.code === "string" ? error.code : "unknown";
    const message = typeof error.message === "string" ? error.message : "";
    if (code === "PAIRING_REQUIRED") {
      return "The OpenClaw gateway requires device pairing for this connection. Start T3's own gateway (leave Gateway URL empty) or approve this client on the gateway host with `openclaw devices approve`.";
    }
    if (code === "UNAUTHORIZED" || code === "FORBIDDEN" || code === "AUTH_TOKEN_MISMATCH") {
      return "The OpenClaw gateway rejected the connection token. Check the Gateway token setting.";
    }
    return message.length > 0 ? `${code}: ${message}` : `Gateway connect failed (${code}).`;
  }
  return "Gateway connect failed.";
}

function openClawRpcErrorDetail(error: unknown): string {
  if (isRecord(error)) {
    const code = typeof error.code === "string" ? error.code : "unknown";
    const message = typeof error.message === "string" ? error.message : "";
    if (message.length > 0) {
      return `${code}: ${message}`;
    }
    const details = error.details;
    if (isRecord(details) && typeof details.reason === "string") {
      return `${code}: ${details.reason}`;
    }
    return `Gateway request failed (${code}).`;
  }
  return "Gateway request failed.";
}

export class OpenClawRuntime extends Context.Service<OpenClawRuntime, OpenClawRuntimeShape>()(
  "t3/provider/openclawRuntime",
) {}

export const OpenClawRuntimeLive = Layer.effect(OpenClawRuntime, makeOpenClawRuntime).pipe(
  Layer.provideMerge(NetService.layer),
);
