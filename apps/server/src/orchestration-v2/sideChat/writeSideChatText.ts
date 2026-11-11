import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";

/**
 * Builds `writeSideChatText`, the one path every side-chat summary and note takes: the model is
 * resolved against the lesson (`thread`), and the provider runs in an empty temp directory.
 */
export const makeWriteSideChatText = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;

  return Effect.fn("writeSideChatText")(function* (input: {
    readonly thread: Pick<OrchestrationV2AppThread, "providerInstanceId" | "projectId">;
    readonly kind: TextGeneration.SideChatTextKind;
    readonly prompt: string;
  }) {
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      input.thread.projectId,
    ).settings;
    const modelSelection = ServerSettings.resolveSideChatTextModel(
      input.thread,
      settings,
      yield* providerRegistry.getProviders,
    );
    return yield* TextGeneration.generateIsolatedSideChatText({
      kind: input.kind,
      prompt: input.prompt,
      modelSelection,
      projectId: input.thread.projectId,
    }).pipe(
      Effect.provideService(TextGeneration.TextGeneration, textGeneration),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  });
});
