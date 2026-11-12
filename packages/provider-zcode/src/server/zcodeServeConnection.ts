// Transport shim: presents the `zcode serve` daemon through the request/event surface the
// session layer already speaks. Requests map to daemon channel calls; events come from the
// row-based v4 conversation projection, folded by `zcodeServeConversation`.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";

import {
  ZcodeProtocolError,
  type ZcodeConnection,
  type ZcodeProtocolTimeoutError,
  type ZcodeRecord,
} from "./zcodeProtocol.ts";
import { zcodeChannelUrl, connectZcodeServer } from "./zcodeServeDaemon.ts";
import {
  applyConversationPayload,
  initialConversationState,
  interactionAnswer,
  type ZcodeConversationState,
} from "./zcodeServeConversation.ts";
import { makeZcodeChannelClient, type ZcodeChannelClient } from "./zcodeServeProtocol.ts";

const CLIENT_ID = "t3-code";
const DEFAULT_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 150_000;

// Command ids only need to be unique, so draw from the process's own WebCrypto rather than
// threading a service through the adapter's fixed environment requirements.
const random = SecureRandom.make((size) => globalThis.crypto.getRandomValues(new Uint8Array(size)));

export interface ZcodeServeConnectionOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly settings: { readonly binaryPath: string; readonly launchArgs: string };
  readonly cwd: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly httpClient: HttpClient.HttpClient;
}

interface ZcodeWorkspaceParams {
  readonly workspacePath: string;
  readonly workspaceIdentity: string;
  readonly projectId: string;
}

const recordField = (record: unknown, key: string): unknown =>
  Predicate.isObject(record) ? record[key] : undefined;

const recordString = (record: unknown, key: string): string | undefined => {
  const value = recordField(record, key);
  return Predicate.isString(value) ? value : undefined;
};

/**
 * The daemon refuses to start a session for a workspace it has no project record for. The host
 * channel here is a remote host, so `reuseExistingRoot` is rejected; match the root ourselves so
 * repeated attaches do not mint duplicate projects.
 */
const resolveProjectId = Effect.fn("ZcodeServe.resolveProject")(function* (
  channel: ZcodeChannelClient,
  workspacePath: string,
) {
  const existing = yield* channel.call("project", "readProjects", { includeDeleted: false });
  const match = Array.isArray(existing)
    ? existing.find((project) => {
        if (!Predicate.isObject(project) || project["deleted"] === true) return false;
        const roots = project["roots"];
        return Array.isArray(roots) && recordString(roots[0], "rootPath") === workspacePath;
      })
    : undefined;
  const existingId = recordString(match, "id");
  if (existingId !== undefined) return existingId;

  const saved = yield* channel.call("project", "saveProject", {
    roots: [workspacePath],
    primaryRoot: workspacePath,
    defaultName: workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "zcode",
  });
  const id = recordString(saved, "id");
  if (id === undefined) {
    return yield* new ZcodeProtocolError({
      operation: "resolveProject",
      detail: "zcode server did not return a project id for the workspace.",
    });
  }
  return id;
});

/** The daemon advertises its session model on the snapshot; the session layer only needs it as a default. */
const availableModelDescriptors = (
  state: ZcodeConversationState,
  settings: unknown,
): ReadonlyArray<ZcodeRecord> => {
  const model = recordField(recordField(settings, "model"), "available");
  if (Array.isArray(model) && model.length > 0) return model.filter(Predicate.isObject);
  const selection = state.modelSelection;
  if (selection === undefined) return [];
  return [
    {
      ref: { providerId: selection.providerId, modelId: selection.modelId },
      ...(state.thoughtLevel === undefined
        ? {}
        : { reasoning: { defaultLevel: state.thoughtLevel, levels: state.thoughtLevels } }),
    },
  ];
};

const readLegacySettings = Effect.fn("ZcodeServe.readSettings")(function* (
  channel: ZcodeChannelClient,
  workspace: ZcodeWorkspaceParams,
  sessionId: string,
) {
  const snapshot = yield* channel.call("zcode-agent", "readSession", {
    ...workspace,
    sessionId,
    deliveryKind: "desktop-continuous",
  });
  return recordField(snapshot, "settings");
});

export const makeZcodeServeConnection = Effect.fn("ZcodeServeConnection.make")(function* (
  options: ZcodeServeConnectionOptions,
) {
  const scope = yield* Effect.scope;
  const server = yield* connectZcodeServer({
    settings: options.settings,
    environment: options.environment,
    fileSystem: options.fileSystem,
    httpClient: options.httpClient,
  });
  const channel = yield* makeZcodeChannelClient({
    url: zcodeChannelUrl(server.status, server.token),
    headers: { "x-zcode-rpc-host-capability": server.capability },
  });
  const projectId = yield* resolveProjectId(channel, options.cwd);
  const workspace: ZcodeWorkspaceParams = {
    workspacePath: options.cwd,
    workspaceIdentity: projectId,
    projectId,
  };
  yield* channel.call("zcode-agent", "initialize", workspace).pipe(
    Effect.tap((initialized) =>
      recordField(initialized, "available") === true
        ? Effect.void
        : Effect.logWarning("ZCode agent reports no usable provider for this workspace.", {
            reason: recordField(initialized, "reason") ?? null,
          }),
    ),
    Effect.ignore,
  );

  const events = yield* Queue.unbounded<ZcodeRecord, ZcodeProtocolError>();
  const exitDeferred = yield* Deferred.make<number, ZcodeProtocolError>();
  let conversation: ZcodeConversationState = initialConversationState();
  let sessionId: string | undefined;
  let seeding = false;

  const foldFrame = (frame: unknown): void => {
    if (recordField(frame, "kind") !== "complete") return;
    if (sessionId === undefined) return;
    const topic = recordString(frame, "topic");
    // The listener is workspace-scoped; the topic names the conversation this client subscribed.
    if (topic !== undefined && topic !== `conversation/${sessionId}`) return;
    const payload = recordField(recordField(frame, "frame"), "payload");
    if (!Predicate.isObject(payload)) return;
    const seedRows = seeding && recordString(payload, "kind") === "snapshot";
    if (seedRows) seeding = false;
    for (const event of applyConversationPayload(conversation, payload, { seedRows })) {
      if (event.type === "server.request") {
        const requestParams = recordField(event.payload, "params");
        Queue.offerUnsafe(events, {
          id: recordString(requestParams, "requestId") ?? "",
          method: recordString(event.payload, "method") ?? "",
          params: Predicate.isObject(requestParams) ? requestParams : {},
        });
        continue;
      }
      Queue.offerUnsafe(events, { method: "session/event", params: event });
    }
  };

  yield* channel.listen("zcode-agent", "onDynamicConversationFrame", workspace, foldFrame);
  yield* channel.listen("zcode-agent", "onDynamicSessionLifecycle", workspace, (snapshot) => {
    if (!Predicate.isObject(snapshot)) return;
    const eventSessionId = recordString(snapshot, "sessionId");
    if (sessionId !== undefined && eventSessionId !== undefined && eventSessionId !== sessionId) {
      return;
    }
    Queue.offerUnsafe(events, { method: "session/lifecycle/changed", params: snapshot });
  });

  yield* channel.closed.pipe(
    Effect.andThen(
      Deferred.fail(
        exitDeferred,
        new ZcodeProtocolError({
          operation: "exit",
          detail: "zcode server channel closed",
        }),
      ),
    ),
    Effect.andThen(
      Queue.fail(
        events,
        new ZcodeProtocolError({ operation: "exit", detail: "zcode server channel closed" }),
      ),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  const subscribe = Effect.fn("ZcodeServe.subscribe")(function* (nativeSessionId: string) {
    conversation = initialConversationState();
    sessionId = nativeSessionId;
    seeding = true;
    return yield* channel.call("zcode-agent", "subscribeConversationV4", {
      ...workspace,
      sessionId: nativeSessionId,
      visibility: "foreground",
    });
  });

  const commitCommand = Effect.fn("ZcodeServe.commitCommand")(function* (
    type: string,
    nativeSessionId: string,
    payload: ZcodeRecord,
  ) {
    const commandId = yield* random.uuidV4();
    const issuedAt = yield* Clock.currentTimeMillis;
    return yield* channel.call("zcode-agent", "sendConversationCommandV4", {
      ...workspace,
      envelope: {
        commandId,
        clientId: CLIENT_ID,
        sessionId: nativeSessionId,
        type,
        payload,
        issuedAt,
      },
    });
  });

  /** Translates a session-layer answer into the daemon's `resolveInteraction` shape. */
  const respond = Effect.fnUntraced(function* (id: string, result: unknown) {
    const interaction = conversation.pendingInteractions.get(id);
    const answer = interactionAnswer(interaction, result);
    if (answer === undefined || sessionId === undefined) return;
    yield* commitCommand("resolveInteraction", sessionId, {
      interactionId: id,
      answer,
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          // A resubscribe may surface the still-pending interaction again.
          conversation.announcedInteractions.delete(id);
        }),
      ),
    );
    // Only forget the interaction once the daemon accepted the answer; a failed resolve must
    // keep it pending so the UI can retry instead of silently dropping the request.
    conversation.pendingInteractions.delete(id);
  });

  const request = Effect.fn("ZcodeServe.request")(function* (
    method: string,
    params: ZcodeRecord,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Effect.fn.Return<unknown, ZcodeProtocolError | ZcodeProtocolTimeoutError> {
    switch (method) {
      case "session/create": {
        const workspaceRef = recordField(params, "workspace");
        const requestedCwd = recordString(workspaceRef, "workspacePath");
        const mode = recordString(params, "mode");
        const mcpServers = recordField(params, "mcpServers");
        const created = yield* channel.call(
          "zcode-session",
          "createSession",
          {
            ...workspace,
            ...(requestedCwd === undefined ? {} : { workspacePath: requestedCwd }),
            ...(mode === undefined ? {} : { mode }),
            ...(Array.isArray(mcpServers) ? { mcpServers } : {}),
          },
          timeoutMs,
        );
        const nativeSessionId = recordString(recordField(created, "session"), "sessionId");
        if (nativeSessionId === undefined) {
          return yield* new ZcodeProtocolError({
            operation: method,
            detail: "zcode server returned no session id.",
          });
        }
        const settings = recordField(created, "settings");
        return {
          session: { sessionId: nativeSessionId },
          settings: {
            model: { available: availableModelDescriptors(conversation, settings) },
          },
        };
      }
      case "session/subscribe": {
        const nativeSessionId = recordString(params, "sessionId");
        if (nativeSessionId === undefined) return { snapshot: {} };
        yield* subscribe(nativeSessionId);
        const settings = yield* readLegacySettings(channel, workspace, nativeSessionId).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        return {
          snapshot: {
            settings: {
              model: { available: availableModelDescriptors(conversation, settings) },
            },
          },
        };
      }
      case "session/resume": {
        const nativeSessionId = recordString(params, "sessionId");
        if (nativeSessionId === undefined) {
          return yield* new ZcodeProtocolError({
            operation: method,
            detail: "session/resume needs a sessionId",
          });
        }
        const mcpServers = recordField(params, "mcpServers");
        yield* channel.call(
          "zcode-agent",
          "resumeSession",
          {
            ...workspace,
            sessionId: nativeSessionId,
            ...(Array.isArray(mcpServers) ? { mcpServers } : {}),
          },
          CREATE_TIMEOUT_MS,
        );
        sessionId = nativeSessionId;
        return {};
      }
      case "session/setMode": {
        const nativeSessionId = recordString(params, "sessionId");
        const mode = recordString(params, "mode");
        if (nativeSessionId === undefined || mode === undefined) return {};
        yield* channel.call("zcode-agent", "setMode", {
          ...workspace,
          sessionId: nativeSessionId,
          mode,
        });
        return {};
      }
      case "session/send": {
        const nativeSessionId = recordString(params, "sessionId");
        const content = recordString(params, "content");
        if (nativeSessionId === undefined || content === undefined) {
          return yield* new ZcodeProtocolError({
            operation: method,
            detail: "session/send needs a sessionId and content.",
          });
        }
        const modelSelection = recordField(params, "modelSelection");
        const inputId = yield* random.uuidV4();
        return yield* channel.call("zcode-agent", "sendPrompt", {
          ...workspace,
          sessionId: nativeSessionId,
          inputId,
          content,
          ...(Predicate.isObject(modelSelection) ? { modelSelection } : {}),
        });
      }
      case "session/compact": {
        const nativeSessionId = recordString(params, "sessionId");
        if (nativeSessionId === undefined) return {};
        const instructions = recordString(params, "instructions");
        const inputId = yield* random.uuidV4();
        return yield* channel.call(
          "zcode-agent",
          "compactSession",
          {
            ...workspace,
            sessionId: nativeSessionId,
            inputId,
            ...(instructions === undefined ? {} : { instructions }),
          },
          CREATE_TIMEOUT_MS,
        );
      }
      case "session/stop": {
        const nativeSessionId = recordString(params, "sessionId") ?? sessionId;
        if (nativeSessionId === undefined) return {};
        const executionId = conversation.foregroundExecutionId;
        yield* commitCommand(
          "stop",
          nativeSessionId,
          executionId === undefined ? {} : { expectedForegroundExecutionId: executionId },
        );
        return {};
      }
      case "session/read": {
        const nativeSessionId = recordString(params, "sessionId");
        if (nativeSessionId === undefined) return {};
        return yield* channel.call("zcode-agent", "readSession", {
          ...workspace,
          sessionId: nativeSessionId,
          deliveryKind: "desktop-continuous",
        });
      }
      default:
        return yield* new ZcodeProtocolError({
          operation: method,
          detail: "unsupported zcode server request",
        });
    }
  });

  return {
    request,
    respond,
    events,
    exited: Deferred.await(exitDeferred),
    terminate: Effect.void,
  } satisfies ZcodeConnection;
});
