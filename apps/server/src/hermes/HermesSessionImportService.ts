import {
  CommandId,
  type HermesDiscoveredSession,
  type HermesHistoryResetInput,
  type HermesHistoryResetResult,
  type HermesSessionDiscoveryInput,
  type HermesSessionDiscoveryResult,
  type HermesSessionImportCapabilities,
  type HermesSessionImportInput,
  type HermesSessionImportResult,
  HermesSessionsError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  HermesSessionBindingRepository,
  type HermesSessionImport,
} from "./HermesSessionBindingRepository.ts";
import {
  hermesImportCapabilityError,
  type HermesSessionCatalogSnapshot,
} from "./HermesSessionCatalog.ts";

export { hermesImportCapabilityError } from "./HermesSessionCatalog.ts";

const HERMES = ProviderDriverKind.make("hermes");
const MAX_DISCOVERY_LIMIT = 10_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
export const HERMES_IMPORT_UNSETTLED_WINDOW_MS = 72 * 60 * 60 * 1_000;

/**
 * Built-in messaging transports declared by the pinned Hermes Platform enum.
 * `local` is deliberately absent: T3 Work onboarding imports transport
 * conversations, not CLI/TUI/ACP/code sessions. Unknown/custom source labels
 * remain visible to Hermes itself but are not guessed to be transports here.
 */
export const HERMES_IMPORT_TRANSPORT_SOURCES = [
  "telegram",
  "discord",
  "whatsapp",
  "whatsapp_cloud",
  "slack",
  "signal",
  "mattermost",
  "matrix",
  "homeassistant",
  "email",
  "sms",
  "dingtalk",
  "api_server",
  "webhook",
  "msgraph_webhook",
  "feishu",
  "wecom",
  "wecom_callback",
  "weixin",
  "bluebubbles",
  "qqbot",
  "yuanbao",
  "relay",
] as const;

const HERMES_IMPORT_TRANSPORT_SOURCE_SET = new Set<string>(HERMES_IMPORT_TRANSPORT_SOURCES);

export function isHermesImportTransportSource(source: string): boolean {
  return HERMES_IMPORT_TRANSPORT_SOURCE_SET.has(source.trim().toLowerCase());
}

export function classifyHermesImportedSession(
  startedAtSeconds: number,
  nowMillis: number,
): "unsettled" | "settled" {
  return startedAtSeconds * 1_000 >= nowMillis - HERMES_IMPORT_UNSETTLED_WINDOW_MS
    ? "unsettled"
    : "settled";
}

export function isHermesSessionWithinImportAge(
  startedAtSeconds: number,
  activeWithinDays: number,
  nowMillis: number,
): boolean {
  return startedAtSeconds * 1_000 >= nowMillis - activeWithinDays * DAY_MS;
}

export const HERMES_SESSION_IMPORT_CAPABILITIES: HermesSessionImportCapabilities = {
  discovery: true,
  lazyHistory: true,
  transportSources: [...HERMES_IMPORT_TRANSPORT_SOURCES],
  activityTimestamp: {
    field: "started_at",
    limitation:
      "The pinned session.list response omits last_active; classification uses its only timestamp, started_at.",
  },
  childSessionLineage: {
    available: false,
    reason:
      "The pinned session.list response does not expose parent_session_id, so imported child lineage cannot be reconstructed safely.",
  },
  copyChildSession: {
    available: false,
    reason:
      "The pinned session.branch method copies only the latest live head and has no stable source message/run boundary.",
  },
};

const digest = (...parts: ReadonlyArray<unknown>): string =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const freshImportIdentity = (kind: "main" | "session") => {
  const id = NodeCrypto.randomUUID();
  return {
    importId: `hermes-import:${kind}:${id}`,
    threadId: ThreadId.make(`thread:hermes:${kind}:${id}`),
  } as const;
};

const isHermesSessionsError = Schema.is(HermesSessionsError);

function asImportError(cause: unknown): HermesSessionsError {
  return isHermesSessionsError(cause)
    ? cause
    : new HermesSessionsError({
        code: "import_failed",
        message: "Hermes session import failed.",
        cause,
      });
}

function asHistoryResetError(cause: unknown): HermesSessionsError {
  return isHermesSessionsError(cause)
    ? cause
    : new HermesSessionsError({
        code: "history_reset_failed",
        message: "T3 Work history reset failed.",
        cause,
      });
}

export interface HermesSessionImportServiceShape {
  readonly hydrateThread: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly discover: (
    input: HermesSessionDiscoveryInput,
  ) => Effect.Effect<HermesSessionDiscoveryResult, HermesSessionsError>;
  readonly importSessions: (
    input: HermesSessionImportInput,
  ) => Effect.Effect<HermesSessionImportResult, HermesSessionsError>;
  readonly resetHistory: (
    input: HermesHistoryResetInput,
  ) => Effect.Effect<HermesHistoryResetResult, HermesSessionsError>;
}

export const make = Effect.gen(function* () {
  const instances = yield* ProviderInstanceRegistry;
  const repository = yield* HermesSessionBindingRepository;
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectService;
  const config = yield* ServerConfig;
  const orchestrator = yield* Effect.serviceOption(OrchestratorV2);

  const hydrateThread = Effect.fn("HermesSessionImportService.hydrateThread")(
    function* (threadId: ThreadId) {
      if (Option.isNone(orchestrator)) return true;
      const binding = yield* repository.getByThreadId(String(threadId));
      if (Option.isNone(binding)) return true;
      // Hydration is retried because a transient gateway failure here would
      // otherwise leave a completed import with no projected transcript —
      // unrecoverable once the upstream session vanishes.
      yield* orchestrator.value
        .hydrateProviderThreadSnapshot({
          threadId,
          providerInstanceId: ProviderInstanceId.make(binding.value.providerInstanceId),
        })
        .pipe(Effect.retry({ times: 3 }));
      return true;
    },
    Effect.catchCause((cause) =>
      Effect.logError("Unable to hydrate imported Hermes thread history", {
        cause,
      }).pipe(Effect.as(false)),
    ),
  );

  const resolveCatalog = Effect.fn("HermesSessionImportService.resolveCatalog")(function* (
    providerInstanceId: HermesSessionDiscoveryInput["providerInstanceId"],
  ) {
    const instance = yield* instances.getInstance(providerInstanceId);
    if (instance === undefined) {
      return yield* new HermesSessionsError({
        code: "provider_not_found",
        message: `Provider instance ${providerInstanceId} was not found.`,
      });
    }
    if (instance.driverKind !== HERMES || instance.hermesSessionCatalog === undefined) {
      return yield* new HermesSessionsError({
        code: "provider_not_hermes",
        message: `Provider instance ${providerInstanceId} is not a Hermes provider.`,
      });
    }
    return instance.hermesSessionCatalog;
  });

  const resolveImportCatalog = Effect.fn("HermesSessionImportService.resolveImportCatalog")(
    function* (providerInstanceId: HermesSessionDiscoveryInput["providerInstanceId"]) {
      const catalog = yield* resolveCatalog(providerInstanceId);
      if (catalog.importEnabled) return catalog;
      return yield* new HermesSessionsError({
        code: "import_failed",
        message: `Hermes profile import is disabled for provider instance ${providerInstanceId}.`,
      });
    },
  );

  const resolveCanonicalProject = Effect.fn("HermesSessionImportService.resolveCanonicalProject")(
    function* () {
      const workspaceRoot = config.t3WorkDir;
      if (workspaceRoot === undefined) {
        return yield* new HermesSessionsError({
          code: "import_failed",
          message: "This environment does not expose a canonical T3 Work directory.",
        });
      }
      const project = yield* projects.getByWorkspaceRoot(workspaceRoot);
      if (Option.isNone(project)) {
        return yield* new HermesSessionsError({
          code: "import_failed",
          message: "The canonical T3 Work backing project is not available in this environment.",
        });
      }
      return project.value;
    },
  );

  const resolveBackingProject = Effect.fn("HermesSessionImportService.resolveBackingProject")(
    function* (callerProjectId: ProjectId) {
      const project = yield* resolveCanonicalProject();
      if (project.id !== callerProjectId) {
        return yield* new HermesSessionsError({
          code: "import_failed",
          message: "The requested backing project is not this environment's T3 Work project.",
        });
      }
      return project;
    },
  );

  const assertImportCompatibility = Effect.fn(
    "HermesSessionImportService.assertImportCompatibility",
  )(function* (snapshot: HermesSessionCatalogSnapshot) {
    const error = hermesImportCapabilityError(snapshot.compatibility);
    if (error !== null) {
      return yield* new HermesSessionsError({
        code: "import_failed",
        message: error,
      });
    }
  });

  const discover = Effect.fn("HermesSessionImportService.discover")(function* (
    input: HermesSessionDiscoveryInput,
  ) {
    const catalog = yield* resolveImportCatalog(input.providerInstanceId);
    const backingProject = yield* resolveCanonicalProject();
    const snapshot = yield* catalog.list(
      Math.max(1, Math.min(MAX_DISCOVERY_LIMIT, Math.trunc(input.limit ?? 200))),
    );
    yield* assertImportCompatibility(snapshot);
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const sessions = yield* Effect.forEach(
      snapshot.sessions.filter((session) => isHermesImportTransportSource(session.source)),
      Effect.fnUntraced(function* (session) {
        const imported = yield* repository.getSessionImportByStoredIdentity({
          providerInstanceId: String(input.providerInstanceId),
          profileKey: snapshot.profileKey,
          projectId: String(backingProject.id),
          storedSessionKey: session.id,
        });
        return {
          storedSessionId: session.id,
          title: session.title,
          preview: session.preview,
          startedAt: session.started_at,
          settlement: classifyHermesImportedSession(session.started_at, nowMillis),
          messageCount: session.message_count,
          source: session.source,
          importedThreadId: Option.isSome(imported) ? ThreadId.make(imported.value.threadId) : null,
        } satisfies HermesDiscoveredSession;
      }),
      { concurrency: 16 },
    );
    const main = yield* repository.getMainSessionImport({
      providerInstanceId: String(input.providerInstanceId),
      profileKey: snapshot.profileKey,
      projectId: String(backingProject.id),
    });
    return {
      providerInstanceId: input.providerInstanceId,
      profileKey: snapshot.profileKey,
      sessions,
      capabilities: HERMES_SESSION_IMPORT_CAPABILITIES,
      mainThreadId: Option.isSome(main) ? ThreadId.make(main.value.threadId) : null,
    } satisfies HermesSessionDiscoveryResult;
  }, Effect.mapError(asImportError));

  const createThreadForImport = Effect.fn("HermesSessionImportService.createThreadForImport")(
    function* (input: {
      readonly row: HermesSessionImport;
      readonly projectId: ProjectId;
      readonly title: string;
      readonly isMain: boolean;
      readonly createdAt?: DateTime.Utc;
    }) {
      if (input.row.state !== "prepared") return;
      yield* threads.dispatch({
        type: "thread.create",
        createdBy: "system",
        creationSource: "provider",
        commandId: CommandId.make(`command:${input.row.importId}:create-thread`),
        threadId: ThreadId.make(input.row.threadId),
        projectId: input.projectId,
        title: input.title.trim() || "Untitled Hermes session",
        modelSelection: {
          instanceId: ProviderInstanceId.make(input.row.providerInstanceId),
          model: "default",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      });
      if (input.isMain) {
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`command:${input.row.importId}:mark-main`),
          threadId: ThreadId.make(input.row.threadId),
          pinned: true,
          workInboxRole: "main",
        });
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* repository.transitionSessionImport({
        importId: input.row.importId,
        from: "prepared",
        to: "thread_created",
        now,
      });
    },
  );

  const ensureMain = Effect.fn("HermesSessionImportService.ensureMain")(function* (input: {
    readonly providerInstanceId: HermesSessionImportInput["providerInstanceId"];
    readonly profileKey: string;
    readonly projectId: ProjectId;
  }) {
    const identity = freshImportIdentity("main");
    const now = DateTime.formatIso(yield* DateTime.now);
    let row = yield* repository.prepareSessionImport({
      importId: identity.importId,
      providerInstanceId: String(input.providerInstanceId),
      profileKey: input.profileKey,
      projectId: String(input.projectId),
      importKind: "main",
      storedSessionKey: null,
      threadId: String(identity.threadId),
      now,
    });
    yield* createThreadForImport({
      row,
      projectId: input.projectId,
      title: "Main",
      isMain: true,
    });
    if (row.state === "prepared") {
      row = {
        ...row,
        state: "thread_created",
        updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      };
    }
    if (row.state === "thread_created") {
      yield* repository.transitionSessionImport({
        importId: row.importId,
        from: "thread_created",
        to: "completed",
        now: DateTime.formatIso(yield* DateTime.now),
      });
    }
    return ThreadId.make(row.threadId);
  });

  const importSessions = Effect.fn("HermesSessionImportService.importSessions")(function* (
    input: HermesSessionImportInput,
  ) {
    const catalog = yield* resolveImportCatalog(input.providerInstanceId);
    const backingProject = yield* resolveBackingProject(input.backingProjectId);
    const requestedLimit =
      input.selection.type === "recent"
        ? Math.max(1, Math.min(MAX_DISCOVERY_LIMIT, Math.trunc(input.selection.limit ?? 20)))
        : MAX_DISCOVERY_LIMIT;
    const snapshot = yield* catalog.list(requestedLimit);
    yield* assertImportCompatibility(snapshot);
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const transportSessions = snapshot.sessions.filter(
      (session) =>
        isHermesImportTransportSource(session.source) &&
        isHermesSessionWithinImportAge(session.started_at, input.activeWithinDays, nowMillis),
    );
    const selectedSessionIds =
      input.selection.type === "selected" ? input.selection.sessionIds : null;
    const selected =
      selectedSessionIds !== null
        ? transportSessions.filter((session) => selectedSessionIds.includes(session.id))
        : transportSessions;
    if (selectedSessionIds !== null && selected.length !== new Set(selectedSessionIds).size) {
      return yield* new HermesSessionsError({
        code: "import_failed",
        message:
          "One or more selected Hermes sessions were not returned by the configured profile.",
      });
    }

    const imported = yield* Effect.forEach(
      selected,
      Effect.fnUntraced(function* (session) {
        const settlement = classifyHermesImportedSession(session.started_at, nowMillis);
        const identity = freshImportIdentity("session");
        const now = DateTime.formatIso(yield* DateTime.now);
        let row = yield* repository.prepareSessionImport({
          importId: identity.importId,
          providerInstanceId: String(input.providerInstanceId),
          profileKey: snapshot.profileKey,
          projectId: String(backingProject.id),
          importKind: "session",
          storedSessionKey: session.id,
          threadId: String(identity.threadId),
          now,
        });
        const threadId = ThreadId.make(row.threadId);
        const wasCompleted = row.state === "completed";
        // session.list has no last_active; started_at is the only upstream
        // timestamp and becomes the imported thread's historical time.
        const startedAt =
          session.started_at !== 0 ? DateTime.makeUnsafe(session.started_at * 1_000) : undefined;
        yield* createThreadForImport({
          row,
          projectId: backingProject.id,
          title: session.title || session.preview || "Hermes session",
          isMain: false,
          ...(startedAt === undefined ? {} : { createdAt: startedAt }),
        });
        if (row.state === "prepared") {
          row = { ...row, state: "thread_created", updatedAt: now };
        }
        if (row.state === "thread_created") {
          if (settlement === "settled") {
            yield* threads.dispatch({
              type: "thread.settle",
              commandId: CommandId.make(`command:${row.importId}:classify-settled`),
              threadId,
              ...(startedAt === undefined ? {} : { settledAt: DateTime.formatIso(startedAt) }),
            });
          }
          const binding = yield* repository.getByStoredIdentity({
            providerInstanceId: String(input.providerInstanceId),
            profileKey: snapshot.profileKey,
            storedSessionKey: session.id,
          });
          if (Option.isNone(binding)) {
            const created = yield* repository.createBinding({
              bindingId: `hermes-binding:${digest(row.threadId)}`,
              providerInstanceId: String(input.providerInstanceId),
              profileKey: snapshot.profileKey,
              projectId: String(backingProject.id),
              storedSessionKey: session.id,
              threadId: String(threadId),
              protocolClassification: snapshot.compatibility.status,
              protocolMajor: snapshot.compatibility.protocol?.major ?? null,
              protocolMinor: snapshot.compatibility.protocol?.minor ?? null,
              capabilities: snapshot.compatibility.capabilities,
              reconciliationCursor: null,
              reconciliationFingerprint: null,
              // Imported bindings carry the upstream started_at so projected
              // history timestamps stay historical rather than import time.
              now: DateTime.formatIso(startedAt ?? (yield* DateTime.now)),
            });
            if (!created) {
              return yield* new HermesSessionsError({
                code: "import_failed",
                message: `Hermes session ${session.id} conflicted with another imported thread.`,
              });
            }
          }
          // Complete the ledger row only once history is projected; a failed
          // hydrate stays in thread_created so re-importing retries it instead
          // of leaving a completed import with an empty transcript.
          const hydrated = yield* hydrateThread(threadId);
          if (hydrated) {
            yield* repository.transitionSessionImport({
              importId: row.importId,
              from: "thread_created",
              to: "completed",
              now: DateTime.formatIso(yield* DateTime.now),
            });
          }
        }
        return {
          storedSessionId: session.id,
          threadId,
          settlement,
          status: wasCompleted ? ("already_imported" as const) : ("imported" as const),
        };
      }),
      { concurrency: 1 },
    );
    let ensuredMainThreadId: ThreadId | null = null;
    if (input.ensureMain === false) {
      const existingMain = yield* repository.getMainSessionImport({
        providerInstanceId: String(input.providerInstanceId),
        profileKey: snapshot.profileKey,
        projectId: String(backingProject.id),
      });
      ensuredMainThreadId = Option.isSome(existingMain)
        ? ThreadId.make(existingMain.value.threadId)
        : null;
    } else {
      ensuredMainThreadId = yield* ensureMain({
        providerInstanceId: input.providerInstanceId,
        profileKey: snapshot.profileKey,
        projectId: backingProject.id,
      });
    }
    return {
      providerInstanceId: input.providerInstanceId,
      profileKey: snapshot.profileKey,
      imported,
      mainThreadId: ensuredMainThreadId,
      capabilities: HERMES_SESSION_IMPORT_CAPABILITIES,
    } satisfies HermesSessionImportResult;
  }, Effect.mapError(asImportError));

  const resetHistory = Effect.fn("HermesSessionImportService.resetHistory")(function* (
    input: HermesHistoryResetInput,
  ) {
    const catalog = yield* resolveCatalog(input.providerInstanceId);
    const backingProject = yield* resolveBackingProject(input.backingProjectId);
    const scope = {
      providerInstanceId: String(input.providerInstanceId),
      profileKey: catalog.profileKey,
      projectId: String(backingProject.id),
    };
    const snapshot = yield* threads.getShellSnapshot();
    const historyThreadIds = new Set(yield* repository.listHistoryThreadIds(scope));
    const targets = [...snapshot.threads, ...snapshot.archivedThreads].filter(
      (thread) =>
        historyThreadIds.has(String(thread.id)) &&
        String(thread.projectId) === scope.projectId &&
        String(thread.providerInstanceId) === scope.providerInstanceId,
    );
    const clearedImportCount = yield* repository.clearHistoryRecords(scope);
    yield* Effect.forEach(
      targets,
      (thread) =>
        threads.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`${input.operationId}:delete:${thread.id}`),
          threadId: thread.id,
        }),
      { concurrency: 1, discard: true },
    );
    return {
      deletedThreadCount: targets.length,
      clearedImportCount,
    } satisfies HermesHistoryResetResult;
  }, Effect.mapError(asHistoryResetError));

  return {
    hydrateThread,
    discover,
    importSessions,
    resetHistory,
  } satisfies HermesSessionImportServiceShape;
});
