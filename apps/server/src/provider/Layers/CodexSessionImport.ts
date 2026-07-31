/**
 * CodexSessionImport live implementation.
 *
 * Import is deliberately one-way at the storage layer: Codex remains the
 * native session owner, while T3 receives a text-only history projection plus
 * a strict continuation binding. This lets either Codex surface keep using
 * the original thread without T3 rewriting any of its files.
 *
 * @module provider/Layers/CodexSessionImport
 */
import {
  CodexSessionImportError,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type CodexSessionImportInput,
  type CodexSessionListInput,
  type ModelSelection,
  ProviderDriverKind,
  TrimmedNonEmptyString,
  ThreadId,
  CommandId,
  MessageId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type {
  ProviderInstance,
  ProviderThreadHistory,
  ProviderThreadHistoryCandidate,
  ProviderThreadHistorySource,
} from "../ProviderDriver.ts";
import { isCodexResumeCursor } from "./CodexSessionRuntime.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { CodexSessionImport } from "../Services/CodexSessionImport.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

function importError(operation: string, message: string, cause?: unknown): CodexSessionImportError {
  return new CodexSessionImportError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function stableSegment(value: string): string {
  return encodeURIComponent(value);
}

function importedThreadId(input: {
  readonly providerInstanceId: string;
  readonly externalThreadId: string;
}): ThreadId {
  return ThreadId.make(
    `codex:${stableSegment(input.providerInstanceId)}:${stableSegment(input.externalThreadId)}`,
  );
}

function importCommandId(input: {
  readonly providerInstanceId: string;
  readonly externalThreadId: string;
}): CommandId {
  return CommandId.make(
    `codex-history-import:${stableSegment(input.providerInstanceId)}:${stableSegment(
      input.externalThreadId,
    )}`,
  );
}

function importedMessageId(input: {
  readonly externalThreadId: string;
  readonly externalMessageId: string;
}): MessageId {
  return MessageId.make(
    `codex:${stableSegment(input.externalThreadId)}:message:${stableSegment(input.externalMessageId)}`,
  );
}

function uniqueThreadIds(externalThreadIds: ReadonlyArray<string>): ReadonlyArray<string> {
  return Array.from(new Set(externalThreadIds));
}

function configuredCodexSource(
  instance: ProviderInstance,
): ProviderThreadHistorySource | undefined {
  return instance.enabled && instance.driverKind === CODEX_DRIVER_KIND
    ? instance.threadHistory
    : undefined;
}

const modelSelectionFor = Effect.fn("CodexSessionImport.modelSelectionFor")(function* (input: {
  readonly projectDefault: ModelSelection | null;
  readonly provider: ProviderInstance;
}): Effect.fn.Return<ModelSelection> {
  if (input.projectDefault?.instanceId === input.provider.instanceId) {
    return input.projectDefault;
  }
  const snapshot = yield* input.provider.snapshot.getSnapshot;
  return {
    instanceId: input.provider.instanceId,
    model:
      snapshot.models.find((model) => model.isDefault === true)?.slug ??
      snapshot.models.at(0)?.slug ??
      DEFAULT_MODEL,
  };
});

export const makeCodexSessionImport = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const instanceRegistry = yield* ProviderInstanceRegistry;
  const sessionDirectory = yield* ProviderSessionDirectory;

  const resolveImportContext = Effect.fn("CodexSessionImport.resolveContext")(function* (
    input: CodexSessionListInput,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(input.projectId)
      .pipe(
        Effect.mapError((cause) =>
          importError("resolve-project", "Could not load this T3 project.", cause),
        ),
      );
    if (Option.isNone(project)) {
      return yield* importError("resolve-project", "This T3 project is no longer available.");
    }

    const instance = yield* instanceRegistry.getInstance(input.providerInstanceId);
    const source = instance ? configuredCodexSource(instance) : undefined;
    if (!instance || !source) {
      return yield* importError(
        "resolve-provider",
        "Choose an enabled Codex provider before importing its sessions.",
      );
    }

    return { project: project.value, instance, source };
  });

  const listImportedThreadIds = Effect.fn("CodexSessionImport.listImportedThreadIds")(function* (
    providerInstanceId: string,
  ) {
    const bindings = yield* sessionDirectory
      .listBindings()
      .pipe(
        Effect.mapError((cause) =>
          importError(
            "list-bindings",
            "Could not check which Codex sessions are already imported.",
            cause,
          ),
        ),
      );
    const imported = new Map<string, ThreadId>();
    for (const binding of bindings) {
      if (
        binding.provider === CODEX_DRIVER_KIND &&
        binding.providerInstanceId === providerInstanceId &&
        isCodexResumeCursor(binding.resumeCursor) &&
        binding.resumeCursor.requireExistingThread === true
      ) {
        imported.set(binding.resumeCursor.threadId, binding.threadId);
      }
    }
    return imported;
  });

  const list = Effect.fn("CodexSessionImport.list")(function* (input: CodexSessionListInput) {
    const context = yield* resolveImportContext(input);
    const [sourceResult, imported] = yield* Effect.all([
      context.source
        .listThreads({ cwd: context.project.workspaceRoot })
        .pipe(
          Effect.mapError((cause) =>
            importError(
              "list-sessions",
              "Could not read Codex sessions. Check that Codex is available and try again.",
              cause,
            ),
          ),
        ),
      listImportedThreadIds(input.providerInstanceId),
    ]);

    return {
      sessions: sourceResult.threads.map((session) => ({
        ...session,
        importedThreadId: imported.get(session.externalThreadId) ?? null,
      })),
      truncated: sourceResult.truncated,
    };
  });

  const importSessions = Effect.fn("CodexSessionImport.import")(function* (
    input: CodexSessionImportInput,
  ) {
    const context = yield* resolveImportContext(input);
    const externalThreadIds = uniqueThreadIds(input.externalThreadIds);
    const [listed, existingImports] = yield* Effect.all([
      context.source
        .listThreads({ cwd: context.project.workspaceRoot })
        .pipe(
          Effect.mapError((cause) =>
            importError(
              "validate-sessions",
              "Could not verify the selected Codex sessions. Refresh the list and try again.",
              cause,
            ),
          ),
        ),
      listImportedThreadIds(input.providerInstanceId),
    ]);
    const candidatesById = new Map<string, ProviderThreadHistoryCandidate>(
      listed.threads.map((candidate) => [candidate.externalThreadId, candidate]),
    );
    const unavailableIds = externalThreadIds.filter((threadId) => !candidatesById.has(threadId));
    if (unavailableIds.length > 0) {
      return yield* importError(
        "validate-sessions",
        "One or more selected Codex sessions are no longer available for this project. Refresh the list and try again.",
      );
    }

    const alreadyImportedThreadIds = externalThreadIds.flatMap((externalThreadId) => {
      const threadId = existingImports.get(externalThreadId);
      return threadId ? [threadId] : [];
    });
    const idsToImport = externalThreadIds.filter(
      (externalThreadId) => !existingImports.has(externalThreadId),
    );
    if (idsToImport.length === 0) {
      return { importedThreadIds: [], alreadyImportedThreadIds };
    }

    const [histories, modelSelection] = yield* Effect.all([
      context.source
        .readThreads({
          cwd: context.project.workspaceRoot,
          externalThreadIds: idsToImport,
        })
        .pipe(
          Effect.mapError((cause) =>
            importError(
              "read-sessions",
              "Could not read the selected Codex sessions. They may have changed; refresh and try again.",
              cause,
            ),
          ),
        ),
      modelSelectionFor({
        projectDefault: context.project.defaultModelSelection,
        provider: context.instance,
      }).pipe(
        Effect.mapError((cause) =>
          importError(
            "resolve-model",
            "Could not choose a Codex model for imported sessions.",
            cause,
          ),
        ),
      ),
    ]);
    const historiesById = new Map<string, ProviderThreadHistory>(
      histories.map((history) => [history.externalThreadId, history]),
    );
    const missingHistoryIds = idsToImport.filter((threadId) => !historiesById.has(threadId));
    if (missingHistoryIds.length > 0) {
      return yield* importError(
        "read-sessions",
        "Codex did not return every selected session. Refresh the list and try again.",
      );
    }

    const importedThreadIds = yield* Effect.forEach(
      idsToImport,
      (externalThreadId) => {
        const history = historiesById.get(externalThreadId);
        if (!history) {
          return Effect.fail(
            importError("read-sessions", "A selected Codex session could not be read."),
          );
        }
        const threadId = importedThreadId({
          providerInstanceId: input.providerInstanceId,
          externalThreadId,
        });
        const commandId = importCommandId({
          providerInstanceId: input.providerInstanceId,
          externalThreadId,
        });
        return orchestrationEngine
          .dispatch({
            type: "thread.history.import",
            commandId,
            threadId,
            projectId: input.projectId,
            title: TrimmedNonEmptyString.make(history.title),
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: history.createdAt,
            messages: history.messages.map((message) => ({
              messageId: importedMessageId({
                externalThreadId,
                externalMessageId: message.externalMessageId,
              }),
              role: message.role,
              text: message.text,
              // Imported history has no corresponding T3 turn/checkpoint
              // events. Keep it unbound so a later T3 revert cannot erase the
              // historical snapshot while pruning native T3 turns.
              turnId: null,
              createdAt: message.createdAt,
            })),
          })
          .pipe(
            Effect.mapError((cause) =>
              importError(
                "create-thread",
                "Could not create an imported T3 thread. Some earlier sessions may already be imported; refresh to see the current state.",
                cause,
              ),
            ),
            Effect.flatMap(() =>
              sessionDirectory
                .upsert({
                  threadId,
                  provider: CODEX_DRIVER_KIND,
                  providerInstanceId: input.providerInstanceId,
                  runtimeMode: "full-access",
                  status: "stopped",
                  // Do not fall back to a new native thread if the original was
                  // deleted after import. A failed resume is safer and clearer.
                  resumeCursor: { threadId: externalThreadId, requireExistingThread: true },
                  runtimePayload: {
                    cwd: context.project.workspaceRoot,
                    modelSelection,
                    importedFrom: "codex",
                  },
                })
                .pipe(
                  Effect.mapError((cause) =>
                    importError(
                      "save-binding",
                      "The T3 thread was created but its Codex continuation link could not be saved. Retry this import to repair the link.",
                      cause,
                    ),
                  ),
                ),
            ),
            Effect.as(threadId),
          );
      },
      { concurrency: 1 },
    );

    return { importedThreadIds, alreadyImportedThreadIds };
  });

  return { list, import: importSessions };
});

export const CodexSessionImportLive = Layer.effect(CodexSessionImport, makeCodexSessionImport);
