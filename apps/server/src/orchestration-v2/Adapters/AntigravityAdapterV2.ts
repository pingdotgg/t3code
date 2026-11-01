import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ChatAttachment,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  type OrchestrationV2ProviderCapabilities,
  type ProviderSetupError,
} from "@t3tools/contracts";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { PULL_REQUEST_LINKING_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";
import type { AntigravityAuth } from "../../provider/AntigravityAuth.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  antigravityAppendsSystemPrompt,
  antigravityMovedUploadsNotice,
  antigravityPermissionMode,
  antigravityRuntimeModeForSessionMode,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
  type AntigravityAcpRuntimeInput,
} from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import {
  antigravitySubagentLaunches,
  describeAntigravitySubagentLaunches,
} from "../../provider/acp/AntigravityChildWork.ts";
import { readAntigravityClientTextFile } from "../../provider/acp/AntigravityClientFiles.ts";
import { watchAntigravityPromptOutcome } from "../../provider/acp/AntigravityTurnOutcome.ts";
import {
  antigravityThreadUploadPath,
  antigravityThreadUploadsRoot,
  markAntigravityMovedUploads,
  syncAntigravityThreadUploads,
  takeAntigravityMovedUploads,
} from "../../provider/acp/AntigravityThreadUploads.ts";
import {
  antigravityApprovalOptions,
  antigravitySubagentOutput,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  makeAntigravityReadRepair,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
} from "../../provider/acp/AntigravityProtocol.ts";
import { isAntigravitySignInRequiredError } from "../../provider/antigravityAuthSupport.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

const ANTIGRAVITY_PROVIDER = ProviderDriverKind.make("antigravity");

const AntigravityProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface AntigravityAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly selfInvocation: SelfInvocation;
  readonly makeRuntime: (
    input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError | ProviderSetupError,
    Scope.Scope
  >;
  readonly withProcess: AntigravityAuth["withProcess"];
  readonly defaultModel: Effect.Effect<string | undefined>;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onSessionEvent?: AcpAdapterV2Flavor["onSessionEvent"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  /** The agent's GEMINI_HOME. Its session logs show turns that ended on an upstream error. */
  readonly profileDirectory?: string;
}

/**
 * Native subagent tools report no child session ids, so children stay read-only.
 * Only permission prompts carry the launch; NativeChildWorkQuery matches their ids by this text.
 */
const extractAntigravitySubagentUpdate: NonNullable<AcpAdapterV2Flavor["extractSubagentUpdate"]> = (
  toolCall,
) => {
  if (classifyAntigravitySubagentToolCall(toolCall) !== "subagent") {
    return undefined;
  }
  const status =
    toolCall.status === "failed" ? "failed" : toolCall.status === "pending" ? "pending" : "running";
  const launches = antigravitySubagentLaunches(toolCall.data.rawInput);
  const launch = launches === undefined ? undefined : describeAntigravitySubagentLaunches(launches);
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt:
      launch?.prompt ??
      antigravitySubagentOutput(toolCall) ??
      toolCall.detail ??
      toolCall.title ??
      "Antigravity subagent batch",
    title: launch?.title ?? "Antigravity subagent batch",
    model: null,
    status,
    childSessionId: null,
    result: status === "failed" ? (antigravitySubagentOutput(toolCall) ?? null) : null,
  };
};

interface AntigravityFlavorServices {
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly host: ProviderHost.ProviderHost["Service"];
}

export function makeAntigravityAcpAdapterFlavor(
  options: AntigravityAdapterV2Options & AntigravityFlavorServices,
): AcpAdapterV2Flavor {
  const { profileDirectory } = options;
  const uploadsRoot = (threadId: ThreadId) =>
    antigravityThreadUploadsRoot(options.host.paths.stateDir, threadId);
  const makeRuntime = Effect.fn("AntigravityAdapterV2.makeRuntime")(
    function* (input: AcpAdapterV2RuntimeInput) {
      const storedPaths =
        options.host.readableAttachmentPaths === undefined
          ? []
          : yield* options.host.readableAttachmentPaths(input.threadId);
      // Every start, load and resume rebuilds the copies, so a cold resume can read older uploads.
      const synced = yield* syncAntigravityThreadUploads({
        stateDir: options.host.paths.stateDir,
        threadId: input.threadId,
        attachmentsDir: options.host.paths.attachmentsDir,
        storedPaths,
        prune: true,
      }).pipe(
        Effect.mapError(
          (cause) => new EffectAcpErrors.AcpTransportError({ detail: cause.detail, cause }),
        ),
      );
      if (synced.created && input.resumeSessionId !== undefined && storedPaths.length > 0) {
        yield* markAntigravityMovedUploads(synced.root, storedPaths);
      }
      const scope = yield* Scope.fork(yield* Effect.scope);
      const runtime = yield* options
        .withProcess(
          Scope.close(scope, Exit.void),
          options.makeRuntime({
            ...input,
            clientFileReads: true,
            sessionSystemPromptAppend: PULL_REQUEST_LINKING_INSTRUCTIONS,
            additionalDirectories: [synced.root],
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      // Repair keeps state across updates, so each runtime must have one session-update handler.
      const reads = makeAntigravityReadRepair();
      // Served reads are reported from the read handler, so they take turns with agent updates.
      const updates = yield* Semaphore.make(1);
      let projectUpdate: Parameters<typeof runtime.handleSessionUpdate>[0] | undefined;
      return {
        ...runtime,
        handleReadTextFile: (handler) =>
          runtime.handleReadTextFile((request, context) =>
            handler(request, context).pipe(
              Effect.onExit((exit) => {
                const served = reads.attempted(request.path, Exit.isSuccess(exit));
                if (served === undefined || projectUpdate === undefined) return Effect.void;
                return updates
                  .withPermit(
                    projectUpdate({
                      sessionId: served.sessionId,
                      update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: served.toolCallId,
                        status: "completed",
                      },
                    }),
                  )
                  .pipe(Effect.ignore);
              }),
            ),
          ),
        prompt: (payload, promptOptions) =>
          Effect.sync(reads.reset).pipe(Effect.andThen(runtime.prompt(payload, promptOptions))),
        handleSessionUpdate: (handler) => {
          projectUpdate = handler;
          return runtime.handleSessionUpdate((notification) =>
            updates.withPermit(handler(reads.repair(notification))),
          );
        },
        start: () =>
          runtime
            .start()
            .pipe(
              Effect.tap(
                (started) => options.onSessionStarted?.(started, input.cwd) ?? Effect.void,
              ),
            ),
      } satisfies typeof runtime;
    },
    Effect.provideService(Crypto.Crypto, options.crypto),
    Effect.mapError((cause): EffectAcpErrors.AcpError =>
      cause._tag === "ProviderSetupError"
        ? new EffectAcpErrors.AcpTransportError({ detail: cause.detail, cause })
        : cause,
    ),
  );

  return {
    driver: ANTIGRAVITY_PROVIDER,
    runtimeHarness: "Antigravity",
    capabilities: AntigravityProviderCapabilitiesV2,
    // Agents that advertise HTTP MCP skip the stdio bridge process; others keep stdio.
    mcpOverHttp: true,
    sessionCarriesPullRequestLinking: antigravityAppendsSystemPrompt,
    makeRuntime,
    prepareAttachments: Effect.fn("AntigravityAdapterV2.prepareAttachments")(function* ({
      threadId,
      attachments,
    }) {
      if (attachments.length === 0) return () => null;
      // A message may name another thread's stored upload; copy only this lineage's uploads.
      const owner = toSafeThreadAttachmentSegment(threadId);
      const ownsAll = attachments.every(
        (attachment) => parseThreadSegmentFromAttachmentId(attachment.id) === owner,
      );
      const inherited = new Set(
        ownsAll || options.host.readableAttachmentPaths === undefined
          ? []
          : yield* options.host.readableAttachmentPaths(threadId),
      );
      const readable = (attachment: ChatAttachment) => {
        const stored = options.host.resolveAttachmentPath(attachment);
        return stored !== null &&
          (parseThreadSegmentFromAttachmentId(attachment.id) === owner || inherited.has(stored))
          ? stored
          : null;
      };
      const { root } = yield* syncAntigravityThreadUploads({
        stateDir: options.host.paths.stateDir,
        threadId,
        attachmentsDir: options.host.paths.attachmentsDir,
        storedPaths: attachments.flatMap((attachment) => readable(attachment) ?? []),
        prune: false,
      }).pipe(
        Effect.mapError((cause) => EffectAcpErrors.AcpRequestError.internalError(cause.detail)),
      );
      return (attachment: ChatAttachment) => {
        const stored = readable(attachment);
        return stored === null ? null : antigravityThreadUploadPath(root, stored);
      };
    }),
    buildPrompt: ({
      threadId,
      text,
      attachments,
      resolveAttachmentPath,
      promptCapabilities,
      agentVersion,
      currentModel,
    }) =>
      takeAntigravityMovedUploads(uploadsRoot(threadId)).pipe(
        Effect.flatMap((moved) =>
          buildAntigravityPrompt({
            input: moved === undefined ? text : antigravityMovedUploadsNotice(text, moved),
            attachments,
            resolveAttachmentPath,
            promptCapabilities,
            agentVersion,
            currentModel,
          }),
        ),
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.provideService(Path.Path, options.path),
      ),
    // Loading history replays tool calls; resume avoids replay.
    subagentsIdleOnTurnCompletion: true,
    ...(options.onSessionEvent === undefined ? {} : { onSessionEvent: options.onSessionEvent }),
    applyModelSelection: Effect.fn("AntigravityAdapterV2.applyModelSelection")(function* ({
      runtime,
      modelSelection,
    }) {
      const defaultModel = yield* options.defaultModel;
      return yield* applyAntigravityAcpModelSelection({
        runtime,
        model:
          modelSelection.model === ANTIGRAVITY_DEFAULT_MODEL ? undefined : modelSelection.model,
        defaultModel,
        mapError: (cause) => cause,
      });
    }),
    sessionModeForPolicy: (policy) => antigravityPermissionMode(policy.runtimeMode),
    runtimeModeForSessionMode: antigravityRuntimeModeForSessionMode,
    clientFileSystem: {
      readTextFile: (request, cwd, threadId) =>
        readAntigravityClientTextFile({
          fileSystem: options.fileSystem,
          path: options.path,
          allowedRoots: cwd === null ? [uploadsRoot(threadId)] : [cwd, uploadsRoot(threadId)],
          request,
        }),
    },
    approvalOptions: antigravityApprovalOptions,
    extractPermissionQuestion: (request) => {
      const question = extractAntigravityUserInputQuestion(request);
      if (question === undefined) return undefined;
      return {
        question,
        respond: (answers) => makeAntigravityUserInputResponse(request, answers),
      };
    },
    normalizeToolCall: normalizeAntigravityToolCall,
    extractSubagentUpdate: extractAntigravitySubagentUpdate,
    supportsImagePrompts: true,
    // ACP 1.3.0 treats /compact as ordinary model input.
    supportsCompaction: false,
    requiresSignIn: isAntigravitySignInRequiredError,
    // 1.4.5 returns the root trajectory's Gemini usageMetadata delta; 1.4.1 returns none.
    reportsPerTurnPromptUsage: true,
    promptUsageThoughtsOutsideOutput: true,
    ...(profileDirectory === undefined
      ? {}
      : {
          watchPromptOutcome: (sessionId: string) =>
            watchAntigravityPromptOutcome(profileDirectory, sessionId),
        }),
  };
}

export const makeAntigravityAdapterV2 = Effect.fn("makeAntigravityAdapterV2")(function* (
  options: AntigravityAdapterV2Options,
) {
  const services: AntigravityFlavorServices = {
    crypto: yield* Crypto.Crypto,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    host: yield* ProviderHost.ProviderHost,
  };
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeAntigravityAcpAdapterFlavor({ ...options, ...services }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
});
