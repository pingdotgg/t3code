import {
  IsoDateTime,
  MuseSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { expandHomePath } from "../pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { createMuseSdkHost, type MuseSdkHost } from "../provider/museSdk.ts";

const SessionId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
const SessionMetadata = Schema.Struct({
  sessionId: SessionId,
  path: Schema.String.check(Schema.isMaxLength(32_768)),
  workspaceRoot: Schema.NullOr(Schema.String.check(Schema.isMaxLength(32_768))),
  providerId: Schema.NullOr(Schema.String),
  modelId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MuseImportSession = typeof SessionMetadata.Type;

const SessionList = Schema.Struct({
  sessions: Schema.Array(SessionMetadata).check(Schema.isMaxLength(200)),
  nextCursor: Schema.NullOr(Schema.String),
});
const decodeList = Schema.decodeUnknownEffect(SessionList);
const decodeRead = Schema.decodeUnknownEffect(
  Schema.Struct({
    session: SessionMetadata,
    history: Schema.Struct({
      mode: Schema.String,
      noneReason: Schema.optional(Schema.String),
      snapshot: Schema.optional(Schema.NullOr(Schema.Struct({ schemaVersion: Schema.Int }))),
    }),
  }),
);
const MessageItem = Schema.Struct({
  itemId: Schema.String,
  kind: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  status: Schema.String,
  text: Schema.optional(Schema.String),
  displayText: Schema.optional(Schema.String),
  recordedAt: Schema.optional(IsoDateTime),
  retracted: Schema.optional(Schema.Boolean),
  truncated: Schema.optional(Schema.Boolean),
});
const EffectiveModelId = Schema.String.check(Schema.isPattern(/^\S+$/), Schema.isMaxLength(256));
const HistoryPage = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      method: Schema.String,
      params: Schema.Struct({
        sessionId: Schema.String,
        item: Schema.optional(MessageItem),
        modelId: Schema.optional(Schema.NullOr(EffectiveModelId)),
        providerId: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    }),
  ).check(Schema.isMaxLength(200)),
  nextCursor: Schema.NullOr(Schema.String),
});
const decodePage = Schema.decodeUnknownEffect(HistoryPage);

export interface MuseImportInstance {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
}

/** The host which lists a session owns its continuation; upstream providerId is not an account id. */
export function museImportInstances(settings: ServerSettings, environment: NodeJS.ProcessEnv) {
  const instances = Object.entries(settings.providerInstances)
    .filter(
      ([, instance]) => instance.driver === "muse" && resolveProviderInstanceEnabled(instance),
    )
    .map(([instanceId, config]) => ({ instanceId: ProviderInstanceId.make(instanceId), config }));
  if (!Object.hasOwn(settings.providerInstances, "muse") && settings.providers.muse.enabled) {
    instances.unshift({
      instanceId: ProviderInstanceId.make("muse"),
      config: { driver: ProviderDriverKind.make("muse"), config: settings.providers.muse },
    });
  }
  instances.sort(
    (left, right) => Number(right.instanceId === "muse") - Number(left.instanceId === "muse"),
  );
  const decode = Schema.decodeUnknownOption(MuseSettings);
  return instances.flatMap(({ instanceId, config }): MuseImportInstance[] => {
    const settings = decode(config.config ?? {});
    return Option.isNone(settings)
      ? []
      : [
          {
            instanceId,
            binaryPath: expandHomePath(settings.value.binaryPath),
            environment: mergeProviderInstanceEnvironment(config.environment, environment),
          },
        ];
  });
}

class MuseImportError extends Schema.TaggedError<MuseImportError>()("MuseImportError", {
  detail: Schema.String,
}) {}

/** Read published MSP history while the caller holds real pre/post filesystem identities. */
export const makeMuseSessionImport = Effect.fn("makeMuseSessionImport")(function* (
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  const scope = yield* Scope.Scope;
  const path = yield* Path.Path;
  const hosts = new Map<ProviderInstanceId, MuseSdkHost>();
  const getHost = Effect.fn("MuseSessionImport.getHost")(function* (instance: MuseImportInstance) {
    const existing = hosts.get(instance.instanceId);
    if (existing) return existing;
    const host = yield* Effect.acquireRelease(
      Effect.tryPromise((signal) =>
        createHost({
          binaryPath: instance.binaryPath,
          environment: instance.environment,
          readOnly: true,
          // Stored history is unavailable to an ephemeral host. No sessions or turns are started.
          sessionLogging: true,
          startupTimeoutMs: 8_000,
          signal,
        }),
      ),
      (host) => Effect.promise(() => host.close()),
      { interruptible: true },
    ).pipe(Effect.provideService(Scope.Scope, scope));
    if (
      host.initializeResult.schema.version !== 1 ||
      host.initializeResult.sessionDurability === "ephemeral"
    ) {
      return yield* new MuseImportError({
        detail: "Muse does not expose supported durable history.",
      });
    }
    hosts.set(instance.instanceId, host);
    return host;
  });
  const request = (host: MuseSdkHost, method: string, params: Record<string, unknown>) =>
    Effect.tryPromise(() => host.connection.request(method, params)).pipe(
      Effect.timeout("10 seconds"),
    );

  const isRootSession = (host: MuseSdkHost, session: MuseImportSession) => {
    if (
      !session.path ||
      !path.isAbsolute(session.path) ||
      !session.workspaceRoot ||
      !path.isAbsolute(session.workspaceRoot) ||
      session.providerId !== "meta" ||
      !session.modelId?.trim()
    )
      return false;
    // Native root logs live under date/sessionId; nested subagent/reminder logs must not
    // appear as independent projects. Unknown layouts are skipped without reading raw logs.
    const parts = path
      .relative(path.join(host.initializeResult.museHome, "sessions"), session.path)
      .split(path.sep);
    return (
      parts.length === 5 &&
      /^\d{4}$/.test(parts[0]!) &&
      /^\d{2}$/.test(parts[1]!) &&
      /^\d{2}$/.test(parts[2]!) &&
      parts[3] === session.sessionId &&
      parts[4] === "session.jsonl"
    );
  };

  const list = Effect.fn("MuseSessionImport.list")(function* (
    instance: MuseImportInstance,
    limit: number,
  ) {
    const host = yield* getHost(instance);
    const sessions: MuseImportSession[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let inspected = 0;
    do {
      const page: typeof SessionList.Type = yield* request(host, "session/list", {
        limit: Math.min(200, limit - inspected),
        ...(cursor ? { cursor } : {}),
      }).pipe(Effect.flatMap(decodeList));
      inspected += page.sessions.length;
      sessions.push(...page.sessions.filter((session) => isRootSession(host, session)));
      cursor = page.nextCursor;
      if (cursor !== null && (page.sessions.length === 0 || cursors.has(cursor))) {
        return yield* new MuseImportError({ detail: "Muse session listing did not advance." });
      }
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null && inspected < limit);
    return { sessions, truncated: cursor !== null };
  });

  const read = Effect.fn("MuseSessionImport.read")(function* (
    instance: MuseImportInstance,
    sessionId: string,
    limits: { readonly records: number; readonly historyBytes: number; readonly messages: number },
  ) {
    const host = yield* getHost(instance);
    const read = yield* request(host, "session/read", { sessionId, excludeItems: true }).pipe(
      Effect.flatMap(decodeRead),
    );
    if (
      read.session.sessionId !== sessionId ||
      !isRootSession(host, read.session) ||
      (read.history.snapshot && read.history.snapshot.schemaVersion !== 1) ||
      (read.history.noneReason && !["excluded", "historyBudget"].includes(read.history.noneReason))
    ) {
      return yield* new MuseImportError({ detail: "Muse session history is unavailable." });
    }
    const items = new Map<string, typeof MessageItem.Type>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let recordCount = 0;
    let historyBytes = 0;
    let selectedModelId: string | undefined;
    let observedModelId: string | undefined;
    do {
      if (recordCount >= limits.records)
        return yield* new MuseImportError({
          detail: "Muse history exceeds the import record budget.",
        });
      const page: typeof HistoryPage.Type = yield* request(host, "view/page", {
        sessionId,
        limit: Math.min(200, limits.records - recordCount),
        ...(cursor ? { cursor } : {}),
      }).pipe(Effect.flatMap(decodePage));
      recordCount += page.events.length;
      for (const event of page.events) {
        if (event.params.sessionId !== sessionId)
          return yield* new MuseImportError({ detail: "Muse returned another session's history." });
        if (event.method === "session/modelChanged") {
          if (
            !event.params.modelId ||
            (event.params.providerId !== undefined && event.params.providerId !== "meta")
          )
            return yield* new MuseImportError({ detail: "Muse model selection is unavailable." });
          selectedModelId = event.params.modelId;
          continue;
        }
        if (event.method === "session/tokenUsage") {
          if (event.params.modelId) observedModelId = event.params.modelId;
          continue;
        }
        if (!["item/started", "item/updated", "item/completed"].includes(event.method)) continue;
        const item = event.params.item;
        if (!item || (item.kind !== "userMessage" && item.kind !== "agentMessage")) continue;
        const previous = items.get(item.itemId);
        if (previous && previous.revision >= item.revision) continue;
        historyBytes +=
          Buffer.byteLength(item.text ?? "") +
          Buffer.byteLength(item.displayText ?? "") -
          Buffer.byteLength(previous?.text ?? "") -
          Buffer.byteLength(previous?.displayText ?? "");
        if (historyBytes > limits.historyBytes)
          return yield* new MuseImportError({
            detail: "Muse history exceeds the import text budget.",
          });
        items.set(item.itemId, item);
      }
      cursor = page.nextCursor;
      if (cursor !== null && (page.events.length === 0 || cursors.has(cursor)))
        return yield* new MuseImportError({ detail: "Muse history paging did not advance." });
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    const messages = [...items.values()].flatMap((item) => {
      if (item.retracted || item.status === "inProgress") return [];
      const text = (
        item.kind === "userMessage" ? (item.displayText ?? item.text) : item.text
      )?.trim();
      if (!text) return [];
      return [
        {
          role: item.kind === "userMessage" ? ("user" as const) : ("assistant" as const),
          text,
          createdAt: item.recordedAt ?? read.session.createdAt,
        },
      ];
    });
    // A truncated native surface cannot be imported as if it were the complete reply.
    if ([...items.values()].some((item) => item.truncated))
      return yield* new MuseImportError({ detail: "Muse retained only a truncated message view." });
    const firstUser = messages.find((message) => message.role === "user");
    if (!firstUser)
      return yield* new MuseImportError({ detail: "Muse history contains no user messages." });
    // Muse 1.1.1 can save the base model in metadata for a Contributor session.
    // Explicit selections outrank usage from an older turn finishing after a switch.
    const modelId = selectedModelId ?? observedModelId;
    if (!modelId)
      return yield* new MuseImportError({
        detail:
          "Muse history does not identify its effective model. Complete a turn in Muse Code before importing.",
      });
    const recent = messages.slice(-limits.messages);
    const retained = recent.includes(firstUser)
      ? recent
      : [firstUser, ...recent.slice(-(limits.messages - 1))];
    return {
      session: { ...read.session, modelId },
      messages: retained,
      recordCount,
      title: firstUser.text.split("\n")[0]?.slice(0, 100).trim() || "Imported thread",
    };
  });
  return { list, read };
});
