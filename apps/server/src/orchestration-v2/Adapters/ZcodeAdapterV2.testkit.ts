// Frame-driven unit tests for the ZCode adapter. Every frame below is hand-written from the
// Phase 0 probe notes (PROTOCOL-NOTES.md), i.e. a guess about the protocol; live-recorded
// replay fixtures (Phase 3) must replace or augment these before merge confidence is complete.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ZcodeAdapterV2Driver, ZCODE_PROVIDER } from "@t3tools/provider-zcode/server";
import {
  type ZcodeConnection,
  type ZcodeProtocolError,
  type ZcodeRecord,
  type ZcodeAdapterV2Options,
} from "@t3tools/provider-zcode/testing";

export interface CapturedZcodeRequest {
  readonly method: string;
  readonly params: ZcodeRecord;
}

export interface CapturedZcodeRespond {
  readonly id: string;
  readonly result: unknown;
}

export interface FakeZcodeScenario {
  readonly connection: ZcodeConnection;
  /** Client→server requests in wire order. */
  readonly requests: ReadonlyArray<CapturedZcodeRequest>;
  /** Responses the adapter sent to server→client requests, in order. */
  readonly responds: ReadonlyArray<CapturedZcodeRespond>;
  /** Blocks until the adapter answers the next server→client request. */
  readonly takeRespond: Effect.Effect<CapturedZcodeRespond>;
  /** Pushes a notification record onto the wire for the adapter's pump. */
  readonly offerEvent: (record: ZcodeRecord) => Effect.Effect<void>;
  /** The session id the fake handed out for session/create. */
  readonly createdSessionId: () => string | undefined;
  /** Methods the adapter sent that this fake does not script; must stay empty. */
  readonly unexpectedMethods: () => ReadonlyArray<string>;
}

const KNOWN_METHODS = new Set([
  "provider/updateAccountConfig",
  "provider/refreshRegistry",
  "session/create",
  "session/read",
  "session/resume",
  "session/send",
  "session/stop",
  "session/subscribe",
]);

const SESSION_CREATE_EPOCH_MS = 1_794_206_541_509;

function zcodeSessionCreateResult(sessionId: string, params: ZcodeRecord): ZcodeRecord {
  const workspace = (params["workspace"] ?? {}) as ZcodeRecord;
  return {
    messages: [],
    projection: {
      activeToolCalls: [],
      backgroundJobs: [],
      contextUsed: 0,
      contextWindow: 200000,
      mode: "build",
      pendingPermissions: [],
      sessionId: "unknown",
      status: "idle",
      target: null,
      totalTokenCount: 0,
      turnCount: 0,
    },
    protocol: { name: "ZCode Protocol", version: 1 },
    runtime: {
      eventSeq: 0,
      pendingRequestIds: [],
      goalVerifications: [],
      goalVerificationTimeline: [],
      stateRevision: 0,
    },
    session: {
      createdAt: SESSION_CREATE_EPOCH_MS,
      mode: "build",
      traceId: "trace-fake-zcode",
      sessionId,
      sessionKind: "interactive",
      status: "idle",
      target: null,
      title: "",
      updatedAt: SESSION_CREATE_EPOCH_MS,
      workspace: {
        workspacePath: String(workspace["workspacePath"] ?? ""),
        workspaceKey: String(workspace["workspaceKey"] ?? ""),
      },
    },
    settings: {
      mode: { current: "build" },
      model: { available: [] },
      permission: { mode: "build" },
      thoughtLevel: { available: [], enabled: false },
    },
    slashCommands: [],
  };
}

/** Builds the fake `zcode app-server` NDJSON peer the adapter talks to. */
export const makeFakeZcodeConnection = Effect.fnUntraced(function* (): Effect.fn.Return<
  FakeZcodeScenario,
  never,
  never
> {
  const events = yield* Queue.unbounded<ZcodeRecord, ZcodeProtocolError>();
  const respondQueue = yield* Queue.unbounded<CapturedZcodeRespond>();
  const requests: Array<CapturedZcodeRequest> = [];
  const responds: Array<CapturedZcodeRespond> = [];
  let sessionCounter = 0;
  let serverRequestCounter = 0;
  let createdSessionId: string | undefined;

  const offerServerRequest = (method: string, params: ZcodeRecord) =>
    Queue.offer(events, {
      id: `server-${++serverRequestCounter}`,
      method,
      params,
    }).pipe(Effect.asVoid);

  const request = (
    method: string,
    params: ZcodeRecord,
  ): Effect.Effect<unknown, ZcodeProtocolError> =>
    Effect.gen(function* () {
      requests.push({ method, params });
      if (!KNOWN_METHODS.has(method)) return {};
      switch (method) {
        case "session/create": {
          createdSessionId = `sess_${++sessionCounter}`;
          // The real server asks these while materializing the session runtime.
          yield* offerServerRequest("session/requestRuntimePreferences", {
            sessionId: createdSessionId,
            scope: "runtime-materialization",
          });
          yield* offerServerRequest("interaction/requestOfficialMcpAuthHeaders", {
            mcpKey: "image_search",
            pluginId: "image-search@zcode-plugins-official",
            requestId: "official-mcp-auth:1",
            targetOrigin: "https://zcode.z.ai",
            workspace: {
              workspacePath: String(params["workspace"] ?? ""),
              workspaceKey: String(params["workspace"] ?? ""),
            },
          });
          return zcodeSessionCreateResult(createdSessionId, params);
        }
        case "session/subscribe":
          return { sessionId: createdSessionId, eventSeq: 1, events: [] };
        case "session/send": {
          yield* Queue.offer(events, {
            method: "state.updated",
            params: {
              patch: { status: "running" },
              reason: "prompt_started",
              revision: 1,
              scope: "session",
              sessionId: createdSessionId,
            },
          });
          return { sessionId: createdSessionId, accepted: true, stateRevision: 1 };
        }
        case "provider/updateAccountConfig":
          return {
            receivedRevision: String(params["revision"] ?? ""),
            providerCount: Object.keys((params["providers"] ?? {}) as ZcodeRecord).length,
            status: "received",
          };
        case "provider/refreshRegistry":
          return { refreshed: true };
        case "session/read":
          return zcodeSessionCreateResult(createdSessionId ?? "sess_unknown", params);
        case "session/stop":
        case "session/resume":
          return {};
        default:
          return {};
      }
    });

  const connection: ZcodeConnection = {
    request,
    respond: (id, result) =>
      Effect.gen(function* () {
        const captured: CapturedZcodeRespond = { id, result };
        responds.push(captured);
        yield* Queue.offer(respondQueue, captured);
      }),
    events,
    exited: Effect.never,
    terminate: Effect.void,
  };

  return {
    connection,
    requests,
    responds,
    takeRespond: Queue.take(respondQueue),
    offerEvent: (record) => Queue.offer(events, record).pipe(Effect.asVoid),
    createdSessionId: () => createdSessionId,
    unexpectedMethods: () =>
      requests.filter((call) => !KNOWN_METHODS.has(call.method)).map((call) => call.method),
  };
});

let sharedEventCounter = 0;
let sharedServerRequestCounter = 0;

/**
 * session/event notification with the full envelope inside `params`, exactly as the wire
 * carries it (PROTOCOL-NOTES.md: "params = envelope + type").
 */
export const zcodeSessionEvent = (
  sessionId: string,
  type: string,
  payload: ZcodeRecord,
): ZcodeRecord => ({
  method: "session/event",
  params: {
    eventId: `evt_${++sharedEventCounter}`,
    sessionId,
    turnId: "turn_native_1",
    seq: sharedEventCounter,
    timestamp: SESSION_CREATE_EPOCH_MS + sharedEventCounter,
    deliveryKind: "desktop-continuous",
    type,
    payload,
  },
});

/** Server→client request record the adapter must answer via connection.respond. */
export const zcodeServerRequest = (method: string, params: ZcodeRecord): ZcodeRecord => ({
  id: `server-frame-${++sharedServerRequestCounter}`,
  method,
  params,
});

export const makeZcodeAdapterOptions = (): ZcodeAdapterV2Options => ({
  instanceId: ProviderInstanceId.make(ZcodeAdapterV2Driver.driverKind),
  settings: ZcodeAdapterV2Driver.defaultConfig(),
  environment: {},
});

/** The driver kind the package driver and the hand-built adapter options must agree on. */
export const zcodeDriverKind: typeof ZCODE_PROVIDER = ZCODE_PROVIDER;

/**
 * Context for driving the real adapter: ProviderHost (paths/credentials), node runtime services
 * (spawner/file system/clock), derived id allocation, and the MCP session registry.
 */
export const ZcodeAdapterTestLayer = Layer.mergeAll(
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
);
