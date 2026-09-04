import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
  type ProviderSetupError,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as EffectAcpErrors from "effect-acp/errors";

import type { ServerConfig } from "../../config.ts";
import type { AntigravityAuth } from "../../provider/AntigravityAuth.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import {
  antigravityPermissionMode,
  applyAntigravityAcpModelSelection,
  type AntigravityAcpRuntimeInput,
} from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  readAntigravityClientTextFile,
  writeAntigravityClientTextFile,
} from "../../provider/acp/AntigravityClientFiles.ts";
import {
  antigravityApprovalOptions,
  antigravitySubagentOutput,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
} from "../../provider/acp/AntigravityProtocol.ts";
import type { AcpSessionRuntimeStartResult } from "../../provider/acp/AcpSessionRuntime.ts";
import type { IdAllocatorV2 } from "../IdAllocator.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

export const ANTIGRAVITY_PROVIDER = ProviderDriverKind.make("antigravity");

export const AntigravityProviderCapabilitiesV2 = {
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
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig["Service"];
  /** Spawns the official agent with the instance's Google profile. */
  readonly makeRuntime: (
    input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError | ProviderSetupError,
    Scope.Scope
  >;
  /** Serialises process ownership against sign-in and sign-out. */
  readonly withProcess: AntigravityAuth["withProcess"];
  /** Model to select for the provider default alias, from the manifest. */
  readonly defaultModel: Effect.Effect<string | undefined>;
  readonly onSessionStarted?: (
    started: AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onSessionEvent?: AcpAdapterV2Flavor["onSessionEvent"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
}

/**
 * ACP 1.1.1 exposes subagent invocations as ordinary `start_subagent` tools
 * without child session ids. Project them as subagent items keyed by the tool
 * call so the timeline shows them as delegated work.
 */
const extractAntigravitySubagentUpdate: NonNullable<AcpAdapterV2Flavor["extractSubagentUpdate"]> = (
  toolCall,
) => {
  if (classifyAntigravitySubagentToolCall(toolCall) !== "subagent") {
    return undefined;
  }
  const status =
    toolCall.status === "failed" ? "failed" : toolCall.status === "pending" ? "pending" : "running";
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt:
      antigravitySubagentOutput(toolCall) ??
      toolCall.detail ??
      toolCall.title ??
      "Antigravity subagent batch",
    title: "Antigravity subagent batch",
    model: null,
    status,
    childSessionId: null,
    result: status === "failed" ? (antigravitySubagentOutput(toolCall) ?? null) : null,
  };
};

export function makeAntigravityAcpAdapterFlavor(
  options: AntigravityAdapterV2Options,
): AcpAdapterV2Flavor {
  const makeRuntime = (input: AcpAdapterV2RuntimeInput) =>
    Effect.gen(function* () {
      // AcpAdapterV2 owns the runtime scope; sign-in and sign-out stop the
      // process by closing it, and the adapter respawns on the next turn.
      const scope = yield* Effect.scope;
      // The attachments dir grant lets the agent read pasted files at the
      // paths the turn text references. It is a leaf directory of uploads.
      const allowedRoots = [input.cwd, options.serverConfig.attachmentsDir];
      const runtime = yield* options.withProcess(
        Scope.close(scope, Exit.void),
        options.makeRuntime({
          ...input,
          clientFileSystem: true,
          additionalDirectories: [options.serverConfig.attachmentsDir],
        }),
      );
      yield* runtime.handleReadTextFile((request) =>
        readAntigravityClientTextFile({
          fileSystem: options.fileSystem,
          path: options.path,
          allowedRoots,
          request,
        }),
      );
      yield* runtime.handleWriteTextFile((request) =>
        writeAntigravityClientTextFile({
          fileSystem: options.fileSystem,
          path: options.path,
          allowedRoots,
          request,
        }),
      );
      return {
        ...runtime,
        start: () =>
          runtime
            .start()
            .pipe(
              Effect.tap(
                (started) => options.onSessionStarted?.(started, input.cwd) ?? Effect.void,
              ),
            ),
      };
    }).pipe(
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
    makeRuntime,
    // Loading history replays every tool call; resume restores the session
    // without the replay and is what the official client does.
    preferResumeSession: true,
    subagentsIdleOnTurnCompletion: true,
    ...(options.onSessionEvent === undefined ? {} : { onSessionEvent: options.onSessionEvent }),
    applyModelSelection: ({ runtime, modelSelection }) =>
      Effect.gen(function* () {
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
    approvalOptions: antigravityApprovalOptions,
    extractPermissionQuestion: (request) => {
      const question = extractAntigravityUserInputQuestion(request);
      if (question === undefined) return undefined;
      return {
        question: {
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options.map((option) => ({
            label: option.label,
            description: option.description,
          })),
          multiSelect: false,
        },
        respond: (answers) => makeAntigravityUserInputResponse(request, answers),
      };
    },
    normalizeToolCall: normalizeAntigravityToolCall,
    extractSubagentUpdate: extractAntigravitySubagentUpdate,
    supportsImagePrompts: true,
  };
}

export function makeAntigravityAdapterV2(options: AntigravityAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeAntigravityAcpAdapterFlavor(options),
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
}
