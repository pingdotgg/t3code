// ACP session behaviour extracted from server/adapter.ts (turnPrompt).

import {
  providerMessageTextWithAttachmentPaths,
  isProviderNativeImageAttachment,
} from "@t3tools/provider-core/server/attachmentPrompt";
import {
  t3AcpPromptWithInstructions,
  type T3AcpInstructionState,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { findModelConfigOption } from "./runtimeModel.ts";
import { flattenSelectChoices } from "./sessionConfig.ts";
import { type ChatAttachment, type ThreadId } from "@t3tools/contracts";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as EffectAcpSchema from "effect-acp/compat";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx20 } from "./acpSessionContext.ts";

export const createAcpTurnPrompt = (ctx: AcpSessionCtx20) => {
  const resolvePromptParts = Effect.fnUntraced(function* (
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    sessionId: string,
  ) {
    const prompt: Array<EffectAcpSchema.ContentBlock> = [];
    const mcpSession = yield* ctx.mcpSessions.read(turnInput.threadId);
    const instructionState = {
      interactionMode: turnInput.runtimePolicy.interactionMode,
      hasT3Mcp: mcpSession !== undefined,
      hasDeviceTools: mcpSession?.capabilities?.has("device") === true,
    } satisfies T3AcpInstructionState;
    const previousInstructionState = (yield* Ref.get(ctx.promptInstructionStates)).get(sessionId);
    const compactionMarker = (yield* Ref.get(ctx.compactionMarkers)).get(sessionId);
    const userText =
      ctx.flavor.rewriteUserText === undefined
        ? turnInput.message.text
        : yield* ctx.flavor
            .rewriteUserText(turnInput.message.text, turnInput)
            .pipe(
              Effect.provideService(
                ChildProcessSpawner.ChildProcessSpawner,
                ctx.childProcessSpawner,
              ),
            );
    const messageText = yield* providerMessageTextWithAttachmentPaths({
      text: userText,
      attachments: turnInput.message.attachments,
      resolveAttachmentPath: ctx.host.resolveAttachmentPath,
      resolveExtractedTextPath: ctx.host.resolveExtractedTextPath,
    });
    const isNativeSlashCommand = userText.trimStart().startsWith("/");
    const text = t3AcpPromptWithInstructions({
      prompt: messageText,
      state: instructionState,
      ...(previousInstructionState === undefined || compactionMarker !== undefined
        ? {}
        : { previousState: previousInstructionState }),
    });
    if (text.length > 0) {
      prompt.push({ type: "text", text });
    }
    const imageAttachments = turnInput.message.attachments.filter(
      isProviderNativeImageAttachment,
    );
    if (imageAttachments.length > 0 && !ctx.supportsImagePrompts) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver: ctx.driver,
        detail: "ACP driver did not negotiate image prompt support",
      });
    }
    if (ctx.flavor.buildPrompt) {
      const setup = yield* Ref.get(ctx.activeSessionSetup);
      const modelOption = findModelConfigOption(yield* ctx.runtime.getConfigOptions);
      const currentModelId = modelOption?.currentValue;
      const blocks = yield* ctx.flavor
        .buildPrompt({
          text,
          attachments: turnInput.message.attachments,
          resolveAttachmentPath: ctx.host.resolveAttachmentPath,
          promptCapabilities: setup?.initializeResult.agentCapabilities?.promptCapabilities,
          agentVersion: setup?.initializeResult.agentInfo?.version,
          currentModel:
            typeof currentModelId !== "string" || modelOption === undefined
              ? undefined
              : {
                  id: currentModelId,
                  name: flattenSelectChoices(modelOption.options).find(
                    (choice) => choice.value === currentModelId,
                  )?.name,
                },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver: ctx.driver,
                detail: "Failed to build ACP attachment prompt",
                payload: cause,
              }),
          ),
        );
      prompt.splice(0, prompt.length, ...blocks);
    }
    for (const attachment of ctx.flavor.buildPrompt ? [] : imageAttachments) {
      const path = ctx.host.resolveAttachmentPath(attachment as ChatAttachment);
      if (path === null) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: ctx.driver,
          detail: `Invalid attachment id '${attachment.id}'`,
        });
      }
      const bytes = yield* ctx.fileSystem.readFile(path).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: ctx.driver,
              detail: `Failed to read attachment '${attachment.id}'`,
              reason: "attachment_unreadable",
              payload: cause,
            }),
        ),
      );
      prompt.push({
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType: attachment.mimeType,
      });
    }
    if (prompt.length === 0) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver: ctx.driver,
        detail: "ACP turn requires non-empty text or attachments",
      });
    }
    if (!isNativeSlashCommand) {
      const sessionSetup = yield* Ref.get(ctx.activeSessionSetup);
      prompt.push({
        type: "text",
        text: buildRuntimeInstructions({
          harness: ctx.flavor.runtimeHarness ?? ctx.driver,
          model: turnInput.modelSelection.model,
          pullRequestLinking:
            sessionSetup === null ||
            ctx.flavor.sessionCarriesPullRequestLinking?.(sessionSetup.initializeResult) !== true,
        }),
      });
    }
    return {
      prompt,
      instructionState: text === messageText ? undefined : instructionState,
      compactionMarker,
    };
  });
  const restartRuntimeAfterTeardownIfRequired = Effect.fnUntraced(function* (
    threadId: ThreadId | null,
  ) {
    const restartRequired = yield* Ref.get(ctx.runtimeRestartRequired);
    if (!restartRequired) return false;
    yield* ctx.restartAcpRuntime(threadId);
    yield* Ref.set(ctx.runtimeRestartRequired, false);
    yield* Ref.set(ctx.activeSessionId, null);
    yield* Ref.set(ctx.activeSessionSetup, null);
    yield* Ref.set(ctx.activeSelection, null);
    yield* Ref.set(ctx.activeInteractionMode, null);
    yield* Ref.set(ctx.snapshot, {
      order: [],
      messages: new Map(),
      loadingRole: null,
      loadingMessageId: null,
      loadingIndex: 0,
    });
    return true;
  });
  return {
    resolvePromptParts,
    restartRuntimeAfterTeardownIfRequired,
  };
};
