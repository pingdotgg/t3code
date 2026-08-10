import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  type ModelSelection,
  type OrchestrationProjectShell,
  type ProviderInstanceId,
  type ThreadImportCandidate,
  ThreadImportCandidateId,
  type ThreadImportCommitInput,
  type ThreadImportCommitResult,
  type ThreadImportItemResult,
  ThreadImportError,
  type ThreadImportMessage,
  type ThreadImportProvider,
  type ThreadImportProviderStatus,
  type ThreadImportScanInput,
  type ThreadImportScanResult,
  ThreadId,
  CommandId,
  MessageId,
} from "@t3tools/contracts";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  discoverProviderConversations,
  MAX_IMPORT_MESSAGES,
  providerDriverName,
  stableHash,
  type ImportedConversation,
  type ProviderImportConfig,
} from "./readers.ts";

const IMPORT_PROVIDERS: ReadonlyArray<ThreadImportProvider> = [
  "cursor",
  "claudeAgent",
  "codex",
  "grok",
];

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const isThreadImportError = Schema.is(ThreadImportError);

const error = (code: ConstructorParameters<typeof ThreadImportError>[0]["code"], message: string) =>
  new ThreadImportError({ code, message });

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function makeCandidateId(input: ImportedConversation): ThreadImportCandidateId {
  return ThreadImportCandidateId.make(
    `import:${stableHash(
      `${input.providerInstanceId}\0${input.externalSessionId}\0${input.sourceCwd}`,
    ).slice(0, 48)}`,
  );
}

function makeThreadId(candidateId: ThreadImportCandidateId): ThreadId {
  return ThreadId.make(`imported:${stableHash(String(candidateId)).slice(0, 40)}`);
}

function makeMessageId(input: {
  readonly candidateId: ThreadImportCandidateId;
  readonly index: number;
  readonly message: ImportedConversation["messages"][number];
}): MessageId {
  return MessageId.make(
    `imported-message:${stableHash(
      `${input.candidateId}\0${input.index}\0${input.message.role}\0${input.message.text}`,
    ).slice(0, 40)}`,
  );
}

function titleForConversation(conversation: ImportedConversation): string {
  const title = conversation.title.trim();
  return title.length > 0 ? title.slice(0, 96) : `${conversation.provider} conversation`;
}

function candidateFromConversation(input: {
  readonly conversation: ImportedConversation;
  readonly alreadyImported: boolean;
}): ThreadImportCandidate {
  return {
    candidateId: makeCandidateId(input.conversation),
    provider: input.conversation.provider,
    providerInstanceId: input.conversation.providerInstanceId,
    title: titleForConversation(input.conversation),
    updatedAt: input.conversation.updatedAt as ThreadImportCandidate["updatedAt"],
    messageCount: input.conversation.messages.length,
    sourceLabel: input.conversation.provider,
    canResume: input.conversation.resumeCursor !== null,
    resumeUnavailableReason:
      input.conversation.resumeCursor === null ? "Native resume state was not found." : null,
    alreadyImported: input.alreadyImported,
    warnings: input.conversation.warnings,
  };
}

function messagesForImport(input: {
  readonly conversation: ImportedConversation;
  readonly candidateId: ThreadImportCandidateId;
}): { readonly messages: ReadonlyArray<ThreadImportMessage>; readonly warnings: string[] } {
  const warnings = [...input.conversation.warnings];
  const sourceMessages = input.conversation.messages;
  const truncated = sourceMessages.length > MAX_IMPORT_MESSAGES;
  const retained = truncated ? sourceMessages.slice(-MAX_IMPORT_MESSAGES) : sourceMessages;
  if (truncated) {
    warnings.push(`Older messages were omitted after the ${MAX_IMPORT_MESSAGES}-message limit.`);
  }
  const messages: ThreadImportMessage[] = retained.map((message, index) => ({
    id: makeMessageId({ candidateId: input.candidateId, index, message }),
    role: message.role,
    text: message.text,
    createdAt: message.createdAt as ThreadImportMessage["createdAt"],
  }));
  return { messages, warnings };
}

function modelForConversation(input: {
  readonly conversation: ImportedConversation;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean | undefined;
  }>;
  readonly fallback: ModelSelection | null;
}): ModelSelection {
  const model =
    input.conversation.model ??
    input.models.find((candidate) => candidate.isDefault)?.slug ??
    input.models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make(input.conversation.provider)] ??
    input.fallback?.model ??
    "default";
  return {
    instanceId: input.conversation.providerInstanceId,
    model,
  };
}

function environmentFor(
  settings: Readonly<Record<string, unknown>>,
  instanceId: ProviderInstanceId,
): Readonly<Record<string, string>> {
  const instance = asRecord(settings[String(instanceId)]);
  const variables = Array.isArray(instance.environment) ? instance.environment : [];
  const output: Record<string, string> = {};
  for (const variable of variables) {
    const record = asRecord(variable);
    const name = stringValue(record.name);
    const value = typeof record.value === "string" ? record.value : undefined;
    if (name !== undefined && value !== undefined) output[name] = value;
  }
  return output;
}

interface ScannedProvider {
  readonly provider: ThreadImportProvider;
  readonly status: ThreadImportProviderStatus;
  readonly conversations: ReadonlyArray<ImportedConversation>;
}

export interface ThreadImportServiceShape {
  readonly scan: (
    input: ThreadImportScanInput,
  ) => Effect.Effect<ThreadImportScanResult, ThreadImportError>;
  readonly commit: (
    input: ThreadImportCommitInput,
  ) => Effect.Effect<ThreadImportCommitResult, ThreadImportError>;
}

export class ThreadImportService extends Context.Service<
  ThreadImportService,
  ThreadImportServiceShape
>()("t3/threadImport/ThreadImportService") {}

export const makeThreadImportService = (input: {
  readonly projection: ProjectionSnapshotQuery["Service"];
  readonly engine: OrchestrationEngineService["Service"];
  readonly providerRegistry: ProviderRegistry["Service"];
  readonly providerSessions: ProviderSessionDirectory["Service"];
  readonly settingsService: ServerSettingsService["Service"];
}): ThreadImportServiceShape => {
  const { projection, engine, providerRegistry, providerSessions, settingsService } = input;

  const readProject = (projectId: ThreadImportScanInput["projectId"]) =>
    projection.getProjectShellById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.flatMap((project) =>
        project === undefined
          ? Effect.fail(error("project-not-found", `Project '${projectId}' was not found.`))
          : Effect.succeed(project),
      ),
      Effect.mapError(() => error("project-not-found", `Project '${projectId}' was not found.`)),
    );

  const scanProviders = (project: OrchestrationProjectShell) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(() =>
          error("provider-unavailable", "Provider settings could not be read."),
        ),
      );
      const snapshots = yield* providerRegistry.getProviders.pipe(
        Effect.mapError(() => error("provider-unavailable", "Provider status could not be read.")),
      );
      const providerSettings = asRecord(settings.providers);
      const configuredInstances = asRecord(settings.providerInstances);
      const scanned: ScannedProvider[] = [];

      for (const provider of IMPORT_PROVIDERS) {
        const matching = snapshots.filter(
          (snapshot) => snapshot.driver === provider && snapshot.enabled && snapshot.installed,
        );
        if (matching.length === 0) {
          scanned.push({
            provider,
            status: {
              provider,
              available: false,
              message: "Provider is not configured or installed.",
              candidateCount: 0,
            },
            conversations: [],
          });
          continue;
        }

        const conversations: ImportedConversation[] = [];
        let providerWarning: string | undefined;
        for (const snapshot of matching) {
          const instanceEnvelope = asRecord(configuredInstances[String(snapshot.instanceId)]);
          const instanceConfig = asRecord(instanceEnvelope.config);
          const legacyConfig = asRecord(providerSettings[provider]);
          const importConfig: ProviderImportConfig = {
            provider,
            providerInstanceId: snapshot.instanceId,
            displayName: snapshot.displayName ?? provider,
            config: Object.keys(instanceConfig).length > 0 ? instanceConfig : legacyConfig,
            environment: environmentFor(configuredInstances, snapshot.instanceId),
            defaultModel: snapshot.models.find((model) => model.isDefault)?.slug,
            projectRoot: project.workspaceRoot,
          };
          const discovered = yield* Effect.result(
            Effect.tryPromise({
              try: () => discoverProviderConversations(importConfig),
              catch: () => "provider-history-unavailable" as const,
            }),
          );
          if (Result.isFailure(discovered)) {
            providerWarning = "Provider history could not be read.";
          } else {
            conversations.push(...discovered.success);
          }
        }
        scanned.push({
          provider,
          status: {
            provider,
            available: providerWarning === undefined,
            ...(providerWarning !== undefined ? { message: providerWarning } : {}),
            candidateCount: conversations.length,
          },
          conversations,
        });
      }
      return scanned;
    });

  const existingThreadIds = () =>
    projection.getSnapshot().pipe(
      Effect.map((snapshot) => new Set(snapshot.threads.map((thread) => String(thread.id)))),
      Effect.mapError(() => error("import-failed", "Existing T3 threads could not be read.")),
    );

  const scan = (input: ThreadImportScanInput) =>
    Effect.gen(function* () {
      const project = yield* readProject(input.projectId);
      const providers = yield* scanProviders(project);
      const imported = yield* existingThreadIds();
      const candidates = providers.flatMap((entry) =>
        entry.conversations.map((conversation) => {
          const candidateId = makeCandidateId(conversation);
          return candidateFromConversation({
            conversation,
            alreadyImported: imported.has(String(makeThreadId(candidateId))),
          });
        }),
      );
      return {
        projectId: input.projectId,
        scannedAt: yield* nowIso,
        candidates,
        providers: providers.map((entry) => entry.status),
      };
    });

  const commit = (input: ThreadImportCommitInput) =>
    Effect.gen(function* () {
      const project = yield* readProject(input.projectId);
      const providers = yield* scanProviders(project);
      const imported = yield* existingThreadIds();
      const conversations = new Map(
        providers.flatMap((entry) =>
          entry.conversations.map(
            (conversation) => [String(makeCandidateId(conversation)), conversation] as const,
          ),
        ),
      );
      const providerSnapshots = yield* providerRegistry.getProviders.pipe(
        Effect.mapError(() => error("provider-unavailable", "Provider status could not be read.")),
      );
      const fallbackModel = project.defaultModelSelection;

      const results: ThreadImportItemResult[] = [];
      for (const candidateId of input.candidateIds) {
        const conversation = conversations.get(String(candidateId));
        if (conversation === undefined) {
          results.push({
            candidateId,
            status: "failed",
            threadId: null,
            importedMessageCount: 0,
            warnings: [],
            error: "The source conversation is no longer available.",
          });
          continue;
        }
        const threadId = makeThreadId(candidateId);
        if (imported.has(String(threadId))) {
          results.push({
            candidateId,
            status: "already-imported",
            threadId,
            importedMessageCount: conversation.messages.length,
            warnings: [...conversation.warnings],
          });
          continue;
        }

        const providerSnapshot = providerSnapshots.find(
          (snapshot) => snapshot.instanceId === conversation.providerInstanceId,
        );
        const { messages, warnings } = messagesForImport({ conversation, candidateId });
        if (messages.length === 0) {
          results.push({
            candidateId,
            status: "failed",
            threadId: null,
            importedMessageCount: 0,
            warnings,
            error: "The source conversation contains no readable messages.",
          });
          continue;
        }
        const modelSelection = modelForConversation({
          conversation,
          models: providerSnapshot?.models ?? [],
          fallback: fallbackModel,
        });
        const commandId = CommandId.make(`import:${String(candidateId)}`);
        const dispatch = yield* Effect.result(
          engine.dispatch({
            type: "thread.import",
            commandId,
            threadId,
            projectId: input.projectId,
            title: titleForConversation(conversation),
            modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            messages,
            createdAt: yield* nowIso,
          }),
        );
        if (Result.isFailure(dispatch)) {
          const existing = yield* projection.getThreadShellById(threadId).pipe(
            Effect.map(Option.isSome),
            Effect.orElseSucceed(() => false),
          );
          results.push(
            existing
              ? {
                  candidateId,
                  status: "already-imported",
                  threadId,
                  importedMessageCount: messages.length,
                  warnings,
                }
              : {
                  candidateId,
                  status: "failed",
                  threadId: null,
                  importedMessageCount: 0,
                  warnings,
                  error: "T3 could not create the imported thread.",
                },
          );
          continue;
        }

        let status: ThreadImportItemResult["status"] =
          conversation.resumeCursor === null ? "transcript-only" : "imported";
        if (conversation.resumeCursor !== null) {
          const bindingResult = yield* Effect.result(
            providerSessions.upsert({
              threadId,
              provider: providerDriverName(conversation.provider),
              providerInstanceId: conversation.providerInstanceId,
              status: "stopped",
              resumeCursor: conversation.resumeCursor,
              runtimeMode: input.runtimeMode,
              runtimePayload: {
                cwd: conversation.sourceCwd,
                modelSelection,
              },
            }),
          );
          if (Result.isFailure(bindingResult)) {
            status = "transcript-only";
            warnings.push("Native resume state could not be saved.");
          }
        }
        results.push({
          candidateId,
          status,
          threadId,
          importedMessageCount: messages.length,
          warnings,
        });
      }
      return { projectId: input.projectId, results };
    });

  return {
    scan: (input) => scan(input).pipe(Effect.mapError(mapThreadImportError)),
    commit: (input) => commit(input).pipe(Effect.mapError(mapThreadImportError)),
  } satisfies ThreadImportServiceShape;
};

const mapThreadImportError = (cause: unknown): ThreadImportError =>
  isThreadImportError(cause) ? cause : error("import-failed", "Thread import failed.");

const make = Effect.gen(function* () {
  return makeThreadImportService({
    projection: yield* ProjectionSnapshotQuery,
    engine: yield* OrchestrationEngineService,
    providerRegistry: yield* ProviderRegistry,
    providerSessions: yield* ProviderSessionDirectory,
    settingsService: yield* ServerSettingsService,
  });
});

export const ThreadImportServiceLive = Layer.effect(ThreadImportService, make);
