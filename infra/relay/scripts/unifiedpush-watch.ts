// @effect-diagnostics nodeBuiltinImport:off - The watcher reads a private local config file.
import * as NodeFSP from "node:fs/promises";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { postUnifiedPush } from "../src/agentActivity/unifiedPushSend.ts";
import { makeUnifiedPushWatch } from "../src/agentActivity/unifiedPushWatch.ts";

const Server = Schema.Struct({
  name: Schema.NonEmptyString,
  wsUrl: Schema.NonEmptyString,
  bearerToken: Schema.RedactedFromValue(Schema.NonEmptyString),
});
const Config = Schema.Struct({
  endpoint: Schema.RedactedFromValue(Schema.NonEmptyString),
  deviceId: Schema.NonEmptyString,
  userId: Schema.NonEmptyString.pipe(Schema.withDecodingDefaultKey(Effect.succeed("unifiedpush"))),
  keys: Schema.optionalKey(
    Schema.Struct({
      p256dh: Schema.RedactedFromValue(Schema.NonEmptyString),
      auth: Schema.RedactedFromValue(Schema.NonEmptyString),
    }),
  ),
  servers: Schema.NonEmptyArray(Server),
});

class WatchConfigError extends Schema.TaggedError<WatchConfigError>()("WatchConfigError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  // Decode issues can quote config values, so print only the expected shape.
  override get message() {
    return `Could not read a valid config from ${this.path}. Expected { endpoint, deviceId, userId?, keys?: { p256dh, auth }, servers: [{ name, wsUrl, bearerToken }] } with unique server names.`;
  }
}

const readConfig = Effect.fn("UnifiedPushWatch.readConfig")(function* (path: string) {
  const config = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(path, "utf8"),
    catch: (cause) => new WatchConfigError({ path, cause }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Config))),
    Effect.mapError((cause) => new WatchConfigError({ path, cause })),
  );
  const names = config.servers.map((server) => server.name);
  if (new Set(names).size !== names.length) {
    return yield* new WatchConfigError({ path, cause: "duplicate server name" });
  }
  return config;
});

type Message = NonNullable<ReturnType<ReturnType<typeof makeUnifiedPushWatch>["applySnapshot"]>>;

const main = Effect.gen(function* () {
  const path = process.argv[2];
  if (!path) {
    return yield* Effect.logError("Usage: node scripts/unifiedpush-watch.ts <config.json>");
  }
  const config = yield* readConfig(path);
  const endpoint = Redacted.value(config.endpoint);
  const keys = config.keys && {
    p256dh: Redacted.value(config.keys.p256dh),
    auth: Redacted.value(config.keys.auth),
  };
  const watch = makeUnifiedPushWatch(config);
  const outbox = yield* Queue.unbounded<Message>();
  // Each decision and its enqueue run in one synchronous step so payloads keep their order.
  const push = (decide: (nowMs: number) => Message | null) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Effect.sync(() => {
          const message = decide(now);
          if (message) Queue.offerUnsafe(outbox, message);
        }),
      ),
    );

  const deliver = Effect.gen(function* () {
    const message = yield* Queue.take(outbox);
    const result = yield* postUnifiedPush(endpoint, message.data, keys);
    switch (result.outcome) {
      case "accepted":
        return yield* Effect.logInfo(`Push accepted: ${message.label}`);
      case "gone":
        return yield* Effect.logError(
          `Push endpoint returned ${result.status}: the UnifiedPush subscription is gone. Re-register the phone and update the config.`,
        );
      case "rejected":
        return yield* Effect.logError(`Push rejected with HTTP ${result.status}: ${message.label}`);
      case "unencryptable":
        return yield* Effect.logError(
          `Could not encrypt the push: check the keys in the config. ${message.label} was dropped.`,
        );
      case "expired":
        return yield* Effect.logWarning(`Push dropped after retrying: ${message.label}`);
    }
  }).pipe(Effect.forever);

  type Server = (typeof config.servers)[number];
  const socketUrl = (server: Server) => {
    const url = new URL(server.wsUrl);
    url.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    return url.toString();
  };
  type SessionStatus = { rejected: boolean; synced: boolean };
  const protocolLayer = (server: Server, status: SessionStatus) =>
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(socketUrl(server)).pipe(
          Layer.provide(
            Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => {
              const socket = new NodeWS.WebSocket(url, protocols as string | string[] | undefined, {
                headers: { authorization: `Bearer ${Redacted.value(server.bearerToken)}` },
              });
              socket.on("error", (error) => {
                if (/Unexpected server response: 40[13]\b/.test(error.message)) {
                  status.rejected = true;
                }
              });
              return socket as unknown as globalThis.WebSocket;
            }),
          ),
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
    );

  const session = Effect.fn("UnifiedPushWatch.session")(
    function* (server: Server, status: SessionStatus) {
      const rpc = yield* RpcClient.make(WsRpcGroup);
      const { environment } = yield* rpc[WS_METHODS.serverGetConfig]({});
      const projects = new Map<string, OrchestrationProjectShell>();
      const threads = new Map<string, OrchestrationV2ThreadShell>();
      const stateFor = (thread: OrchestrationV2ThreadShell | undefined) => {
        const project = thread && projects.get(thread.projectId);
        if (!thread || !project || thread.archivedAt) return null;
        return projectThreadAwarenessV2({
          environmentId: environment.environmentId,
          project,
          thread,
        });
      };
      const allStates = () => [...threads.values()].flatMap((thread) => stateFor(thread) ?? []);
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
        Stream.runForEach((item) => {
          switch (item.kind) {
            case "synchronized":
            case "snapshot-required":
              return Effect.void;
            case "snapshot":
              // Repository identity refreshes reuse this item with no threads; only a frame without the field is a full snapshot.
              if (item.resolvedRepositoryIdentityRoots !== undefined) return Effect.void;
              projects.clear();
              threads.clear();
              for (const project of item.snapshot.projects) projects.set(project.id, project);
              for (const thread of item.snapshot.threads) threads.set(thread.id, thread);
              status.synced = true;
              watch.serverConnected(server.name);
              return Effect.logInfo(`Watching ${server.name}`).pipe(
                Effect.andThen(push((now) => watch.applySnapshot(server.name, allStates(), now))),
              );
            case "project.updated":
              projects.set(item.project.id, item.project);
              return push((now) => watch.applySnapshot(server.name, allStates(), now));
            case "project.removed":
              projects.delete(item.projectId);
              return push((now) => watch.applySnapshot(server.name, allStates(), now));
            case "thread.updated":
              threads.set(item.thread.id, item.thread);
              return push((now) =>
                watch.applyThreadUpdate(server.name, item.thread.id, stateFor(item.thread), now),
              );
            case "thread.removed":
              threads.delete(item.threadId);
              return push((now) => watch.applyThreadUpdate(server.name, item.threadId, null, now));
          }
        }),
      );
    },
    (effect, server, status) =>
      effect.pipe(Effect.provide(protocolLayer(server, status)), Effect.scoped),
  );

  const watchServer = Effect.fn("UnifiedPushWatch.watchServer")(function* (server: Server) {
    let failures = 0;
    while (true) {
      const status = { rejected: false, synced: false };
      // Socket errors can carry the bearer header, so causes are dropped, never logged.
      yield* session(server, status).pipe(Effect.ignoreCause);
      failures = status.synced ? 1 : failures + 1;
      if (status.rejected) {
        yield* push((now) => watch.serverRejected(server.name, now));
      }
      const delaySeconds = Math.min(60, 2 ** Math.min(failures - 1, 6));
      yield* Effect.logWarning(
        status.rejected
          ? `${server.name} rejected the watcher's credentials; retrying in ${delaySeconds}s`
          : `${status.synced ? "Lost connection to" : "Cannot connect to"} ${server.name}; retrying in ${delaySeconds}s`,
      );
      yield* Effect.sleep(`${delaySeconds} seconds`);
    }
  });

  yield* Effect.logInfo(`Watching ${config.servers.length} server(s) for UnifiedPush delivery.`);
  yield* Effect.all([deliver, ...config.servers.map(watchServer)], {
    concurrency: "unbounded",
    discard: true,
  });
}).pipe(Effect.provide(FetchHttpClient.layer));

NodeRuntime.runMain(main.pipe(Effect.tapError((error) => Effect.logError(error.message))), {
  disableErrorReporting: true,
});
