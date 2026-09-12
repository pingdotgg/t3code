import * as NodeCrypto from "node:crypto";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ItemLifecyclePayload,
  SharedThread,
  ShareSummary,
  ThreadId,
  ToolActivitySurface,
  ToolLifecycleItemType,
  type ShareOptions,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpEffect, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import {
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivity,
} from "../persistence/Services/ProjectionThreadActivities.ts";

const StoredShare = Schema.Struct({ threadId: ThreadId, snapshot: SharedThread });
const decodeStoredShare = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredShare));
const encodeStoredShare = Schema.encodeEffect(Schema.fromJsonString(StoredShare));
const codePattern = /^[A-Za-z0-9_-]{32}\.json$/;
const isSharedToolItemType = Schema.is(ToolLifecycleItemType);
const isSharedToolStatus = Schema.is(ItemLifecyclePayload.fields.status);
const isSharedToolSurface = Schema.is(ToolActivitySurface);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function printable(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** Native payloads stay private. Only the selected tool input and result fields enter the snapshot. */
export function projectSharedTools(
  activities: readonly ProjectionThreadActivity[],
  options: ShareOptions,
): SharedThread["tools"] {
  if (!options.includeToolCalls && !options.includeToolResults) return [];
  const tools = new Map<string, SharedThread["tools"][number]>();
  for (const activity of activities) {
    const payload = record(activity.payload);
    const data = record(payload?.data);
    const item = record(data?.item);
    const state = record(data?.state);
    const id = typeof payload?.toolCallId === "string" ? payload.toolCallId : activity.activityId;
    const previous = tools.get(id);
    const input = options.includeToolCalls
      ? printable(
          data?.input ??
            data?.rawInput ??
            state?.input ??
            item?.arguments ??
            item?.input ??
            item?.command ??
            data?.command ??
            item?.changes ??
            item?.action ??
            item?.query ??
            item?.prompt ??
            item?.path,
        )
      : undefined;
    const result = options.includeToolResults
      ? printable(
          item?.aggregatedOutput ??
            item?.result ??
            item?.contentItems ??
            item?.results ??
            item?.agentsStates ??
            item?.error ??
            data?.result ??
            state?.output ??
            state?.error ??
            data?.rawOutput ??
            data?.content,
        )
      : undefined;
    const toolName = data?.toolName ?? data?.tool ?? item?.tool ?? payload?.itemType;
    const rawItemType = payload?.itemType;
    const rawStatus = payload?.status;
    const rawToolSurface = payload?.toolSurface;
    const itemType = isSharedToolItemType(rawItemType) ? rawItemType : previous?.itemType;
    const status = options.includeToolResults
      ? rawStatus !== undefined && isSharedToolStatus(rawStatus)
        ? rawStatus
        : activity.kind === "tool.completed"
          ? "completed"
          : previous?.status
      : undefined;
    const toolSurface = options.includeToolCalls
      ? isSharedToolSurface(rawToolSurface)
        ? rawToolSurface
        : previous?.toolSurface
      : undefined;
    // Provider presentation can mix input and output, so it requires both selections.
    const includePresentation = options.includeToolCalls && options.includeToolResults;
    const title = includePresentation
      ? typeof payload?.title === "string"
        ? payload.title
        : previous?.title
      : undefined;
    const detail = includePresentation
      ? typeof payload?.detail === "string"
        ? payload.detail
        : previous?.detail
      : undefined;
    tools.set(id, {
      id,
      name: typeof toolName === "string" ? toolName : "Tool",
      createdAt: previous?.createdAt ?? activity.createdAt,
      turnId: activity.turnId,
      ...(itemType !== undefined ? { itemType } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(toolSurface !== undefined ? { toolSurface } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(input !== undefined || previous?.input !== undefined
        ? { input: input ?? previous?.input }
        : {}),
      ...(result !== undefined || previous?.result !== undefined
        ? { result: result ?? previous?.result }
        : {}),
    });
  }
  return [...tools.values()];
}

function summary(snapshot: SharedThread): ShareSummary {
  return {
    code: snapshot.code,
    title: snapshot.title,
    createdAt: snapshot.createdAt,
    options: snapshot.options,
  };
}

const noCache = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, {
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
    }),
  ),
);

export const sharesHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "shares",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* ServerConfig;
    const snapshots = yield* ProjectionSnapshotQuery;
    const activities = yield* ProjectionThreadActivityRepository;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(config.stateDir, "shares");
    const pathFor = (code: string) => path.join(directory, `${code}.json`);
    const disk = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      operation.pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
    const readStoredShare = Effect.fn("shares.readStoredShare")(function* (filePath: string) {
      const content = yield* fs.readFileString(filePath).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      );
      return content === undefined ? undefined : yield* decodeStoredShare(content);
    });

    return handlers
      .handle(
        "create",
        Effect.fn("shares.create")(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* noCache;
          const thread = yield* snapshots
            .getThreadDetailById(payload.threadId, { activityKinds: [] })
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          if (Option.isNone(thread)) return yield* failEnvironmentNotFound("thread_not_found");
          const rawActivities =
            payload.options.includeToolCalls || payload.options.includeToolResults
              ? yield* activities
                  .listByThreadId({
                    threadId: payload.threadId,
                    activityKinds: ["tool.started", "tool.completed"],
                  })
                  .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)))
              : [];
          const snapshot: SharedThread = {
            code: NodeCrypto.randomBytes(24).toString("base64url"),
            title: thread.value.title,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            provider: thread.value.session?.providerName ?? null,
            options: payload.options,
            messages: thread.value.messages.flatMap((message) =>
              message.role === "system"
                ? []
                : [
                    {
                      id: message.id,
                      role: message.role,
                      text: message.text,
                      createdAt: message.createdAt,
                      turnId: message.turnId,
                    },
                  ],
            ),
            tools: projectSharedTools(rawActivities, payload.options),
            plans: payload.options.includePlans
              ? thread.value.proposedPlans.map((plan) => ({
                  id: plan.id,
                  text: plan.planMarkdown,
                  createdAt: plan.createdAt,
                  turnId: plan.turnId,
                }))
              : [],
          };
          yield* disk(
            Effect.scoped(
              Effect.gen(function* () {
                yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
                const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
                  directory,
                  prefix: ".share-",
                });
                const temporaryPath = path.join(temporaryDirectory, "snapshot.json");
                const contents = yield* encodeStoredShare({ threadId: payload.threadId, snapshot });
                yield* fs.writeFileString(temporaryPath, contents, { flag: "wx", mode: 0o600 });
                // Linking publishes the complete file atomically and refuses to replace an existing code.
                yield* fs.link(temporaryPath, pathFor(snapshot.code));
              }),
            ),
          );
          return summary(snapshot);
        }),
      )
      .handle(
        "list",
        Effect.fn("shares.list")(function* ({ params }) {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* noCache;
          return yield* disk(
            Effect.gen(function* () {
              const filenames = yield* fs.readDirectory(directory).pipe(
                Effect.catchIf(
                  (error) => error.reason._tag === "NotFound",
                  () => Effect.succeed([]),
                ),
              );
              const result: ShareSummary[] = [];
              for (const filename of filenames) {
                if (!codePattern.test(filename)) continue;
                const stored = yield* readStoredShare(path.join(directory, filename));
                if (stored === undefined) continue;
                if (stored.threadId === params.threadId) result.push(summary(stored.snapshot));
              }
              return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            }),
          );
        }),
      )
      .handle(
        "revoke",
        Effect.fn("shares.revoke")(function* ({ params }) {
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* noCache;
          yield* disk(fs.remove(pathFor(params.code), { force: true }));
          return { revoked: true };
        }),
      )
      .handle(
        "read",
        Effect.fn("shares.read")(function* ({ params }) {
          yield* noCache;
          const stored = yield* disk(readStoredShare(pathFor(params.code)));
          if (stored === undefined) return yield* failEnvironmentNotFound("share_not_found");
          return stored.snapshot;
        }),
      );
  }),
).pipe(Layer.provide(ProjectionThreadActivityRepositoryLive));
