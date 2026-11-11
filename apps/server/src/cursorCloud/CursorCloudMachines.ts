import {
  CURSOR_CLOUD_INSTANCE_ID,
  CursorCloudError,
  ProviderInstanceId,
  type CursorCloudMachineStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  CursorCloudMachine,
  exchangeCursorApiKey,
  readCursorCloudAgentStatus,
  readCursorCloudMachineAwake,
  readCursorServerCommit,
  readStoredCursorApiKey,
  resolveCursorCloudServer,
} from "@t3tools/provider-cursor/server/cloudMachine";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettings from "../serverSettings.ts";
import * as CursorCloudMount from "./CursorCloudMount.ts";
import type { CursorCloudMachineOptions } from "./CursorCloudMount.ts";

const STATUS_POLL_INTERVAL = "10 seconds";
const AWAKE_CHECK_TTL_MS = 10_000;
const ACCESS_TOKEN_TTL_MS = 30 * 60_000;
// An open connection keeps the VM awake and billing; close it once nothing uses it.
const IDLE_CONNECTION_MS = 5 * 60_000;
const AGENT_ID = /^bc-[0-9a-f-]+$/;

const decodeCloudConfig = Schema.decodeUnknownOption(
  Schema.Struct({ cloudSourceInstanceId: ProviderInstanceId }),
);

export class CursorCloudMachines extends Context.Service<
  CursorCloudMachines,
  {
    readonly wake: (threadId: ThreadId) => Effect.Effect<void, CursorCloudError>;
    readonly subscribe: (
      threadId: ThreadId,
    ) => Stream.Stream<CursorCloudMachineStatus, CursorCloudError>;
  }
>()("t3/cursorCloud/CursorCloudMachines") {}

interface Connection {
  readonly ready: Deferred.Deferred<CursorCloudMachine, CursorCloudError>;
  machine?: CursorCloudMachine;
  lastUsedAt: number;
}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const host = yield* ProviderHost.ProviderHost;
  const http = yield* HttpClient.HttpClient;
  const sql = yield* SqlClient.SqlClient;
  const mount = yield* CursorCloudMount.CursorCloudMount;
  const commit = yield* readCursorServerCommit;
  const connections = new Map<string, Connection>();
  const listeners = new Set<(agentId: string) => void>();
  const notify = (agentId: string) => {
    for (const listener of listeners) listener(agentId);
  };
  let token: { readonly apiKey: string; readonly value: string; readonly at: number } | undefined;
  const awakeChecks = new Map<string, { readonly at: number; readonly awake: boolean }>();

  const agentFor = Effect.fn("CursorCloudMachines.agentFor")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ readonly agent_id: string | null }>`
      SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS agent_id
      FROM orchestration_v2_projection_provider_threads
      WHERE thread_id = ${threadId}
        AND json_extract(payload_json, '$.providerInstanceId') = ${CURSOR_CLOUD_INSTANCE_ID}
      ORDER BY rowid DESC
      LIMIT 1`.pipe(Effect.mapError(() => new CursorCloudError({ reason: "credentials" })));
    const agentId = rows[0]?.agent_id;
    return agentId && AGENT_ID.test(agentId) ? agentId : undefined;
  });

  const accessToken = Effect.fn("CursorCloudMachines.accessToken")(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => new CursorCloudError({ reason: "credentials" })),
    );
    const cloud = current.providerInstances[CURSOR_CLOUD_INSTANCE_ID];
    const config = decodeCloudConfig(cloud?.config);
    if (!cloud?.enabled || Option.isNone(config)) {
      return yield* new CursorCloudError({ reason: "disabled" });
    }
    const apiKey = yield* readStoredCursorApiKey(config.value.cloudSourceInstanceId).pipe(
      Effect.provideService(ProviderHost.ProviderHost, host),
      Effect.mapError(() => new CursorCloudError({ reason: "credentials" })),
    );
    if (apiKey === undefined) return yield* new CursorCloudError({ reason: "authentication" });
    const now = yield* Clock.currentTimeMillis;
    if (token?.apiKey === apiKey && now - token.at < ACCESS_TOKEN_TTL_MS) return token.value;
    const value = yield* exchangeCursorApiKey(apiKey).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.mapError(() => new CursorCloudError({ reason: "authentication" })),
    );
    token = { apiKey, value, at: now };
    return value;
  });

  const serviceScope = yield* Effect.scope;
  const open = Effect.fn("CursorCloudMachines.open")(function* (agentId: string) {
    const connection: Connection = {
      ready: yield* Deferred.make<CursorCloudMachine, CursorCloudError>(),
      lastUsedAt: yield* Clock.currentTimeMillis,
    };
    connections.set(agentId, connection);
    notify(agentId);
    yield* Effect.gen(function* () {
      const endpoint = yield* resolveCursorCloudServer(yield* accessToken(), agentId, commit).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError(() => new CursorCloudError({ reason: "request" })),
      );
      const connected = yield* Effect.promise(() =>
        CursorCloudMachine.connect(endpoint, { agentId, commit }).then(
          (machine) => ({ machine }) as const,
          (cause: unknown) => ({ cause }) as const,
        ),
      );
      if ("cause" in connected) {
        yield* Effect.logWarning("Could not connect to the Cursor Cloud machine", {
          agentId,
          cause: connected.cause,
        });
        return yield* new CursorCloudError({ reason: "request" });
      }
      return connected.machine;
    }).pipe(
      Effect.tap((machine) =>
        Effect.sync(() => {
          connection.machine = machine;
          machine.onClose(() => {
            if (connections.get(agentId) === connection) connections.delete(agentId);
            notify(agentId);
          });
          notify(agentId);
        }),
      ),
      Effect.tapError(() =>
        Effect.sync(() => {
          if (connections.get(agentId) === connection) connections.delete(agentId);
          notify(agentId);
        }),
      ),
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(connection.ready, exit)),
      // Waking can take a minute; a client leaving must not abandon a half-open connection.
      Effect.forkIn(serviceScope),
    );
    return connection;
  });

  const isAwake = Effect.fn("CursorCloudMachines.isAwake")(function* (agentId: string) {
    const now = yield* Clock.currentTimeMillis;
    const cached = awakeChecks.get(agentId);
    if (cached !== undefined && now - cached.at < AWAKE_CHECK_TTL_MS) return cached.awake;
    const awake = yield* readCursorCloudMachineAwake(yield* accessToken(), agentId).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.mapError(() => new CursorCloudError({ reason: "request" })),
    );
    awakeChecks.set(agentId, { at: now, awake });
    return awake;
  });

  const connect = Effect.fn("CursorCloudMachines.connect")(function* (
    agentId: string,
    options: CursorCloudMachineOptions,
  ) {
    const existing = connections.get(agentId);
    const live = existing !== undefined && existing.machine?.closed !== true;
    if (!live && !options.wake && !(yield* isAwake(agentId))) {
      return yield* new CursorCloudError({ reason: "asleep" });
    }
    const connection = live ? existing : yield* open(agentId);
    connection.lastUsedAt = yield* Clock.currentTimeMillis;
    return yield* Deferred.await(connection.ready);
  });

  const requireAgent = (threadId: ThreadId) =>
    agentFor(threadId).pipe(
      Effect.filterOrFail(
        (agentId): agentId is string => agentId !== undefined,
        () => new CursorCloudError({ reason: "pending" }),
      ),
    );

  const machine = (threadId: ThreadId, options: CursorCloudMachineOptions) =>
    requireAgent(threadId).pipe(Effect.flatMap((agentId) => connect(agentId, options)));

  const status = Effect.fn("CursorCloudMachines.status")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<CursorCloudMachineStatus, CursorCloudError> {
    const agentId = yield* agentFor(threadId);
    if (agentId === undefined) return { state: "pending" };
    const accessTokenValue = yield* accessToken();
    const [agentStatus, awake] = yield* Effect.all(
      [
        readCursorCloudAgentStatus(accessTokenValue, agentId),
        readCursorCloudMachineAwake(accessTokenValue, agentId),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.mapError(() => new CursorCloudError({ reason: "request" })),
    );
    awakeChecks.set(agentId, { at: yield* Clock.currentTimeMillis, awake });
    const connection = connections.get(agentId);
    const connecting = connection !== undefined && connection.machine === undefined;
    const connected = connection?.machine !== undefined && !connection.machine.closed;
    return {
      state:
        agentStatus === "expired"
          ? "expired"
          : connecting || agentStatus === "creating"
            ? "starting"
            : awake || connected
              ? "running"
              : agentStatus === "error"
                ? "error"
                : "asleep",
      ...(agentStatus === undefined ? {} : { agentStatus }),
      agentUrl: `https://cursor.com/agents/${agentId}`,
    };
  });

  const subscribe = (threadId: ThreadId) =>
    Stream.merge(
      Stream.tick(STATUS_POLL_INTERVAL),
      Stream.callback<void>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = () => void Queue.offerUnsafe(queue, undefined);
            listeners.add(listener);
            return listener;
          }),
          (listener) => Effect.sync(() => listeners.delete(listener)),
        ),
      ),
    ).pipe(
      Stream.mapEffect(() =>
        status(threadId).pipe(
          // A missed poll keeps the last status; the next tick retries.
          Effect.asSome,
          Effect.catchTags({
            CursorCloudError: (error) =>
              error.reason === "request" ? Effect.succeedNone : Effect.fail(error),
          }),
        ),
      ),
      Stream.filter(Option.isSome),
      Stream.map((value) => value.value),
      Stream.changesWith(
        (left, right) =>
          left.state === right.state &&
          left.agentStatus === right.agentStatus &&
          left.agentUrl === right.agentUrl,
      ),
    );

  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const connection of connections.values()) {
      const connected = connection.machine;
      if (
        connected !== undefined &&
        connected.activeProcesses === 0 &&
        now - connection.lastUsedAt > IDLE_CONNECTION_MS
      ) {
        connected.close();
      }
    }
  });
  yield* Effect.sleep("1 minute").pipe(Effect.andThen(sweep), Effect.forever, Effect.forkScoped);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const connection of connections.values()) connection.machine?.close();
    }),
  );

  yield* mount.register({ machine });

  return CursorCloudMachines.of({
    wake: Effect.fn("CursorCloudMachines.wake")(function* (threadId) {
      yield* machine(threadId, { wake: true });
    }),
    subscribe,
  });
});

export const layer = Layer.effect(CursorCloudMachines, make);
