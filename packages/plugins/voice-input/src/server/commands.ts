import { PluginCommandName } from "@t3tools/plugin-api/schema";
import type { PluginActivationContext } from "@t3tools/plugin-api/server";
import * as Effect from "effect/Effect";

import { VOICE_INPUT_COMMANDS } from "../shared/constants.ts";
import {
  VoiceInputClientStateGetInput,
  VoiceInputClientStateGetResult,
  VoiceInputDependenciesStatusInput,
  VoiceInputDependenciesStatusResult,
  VoiceInputModelDownloadInput,
  VoiceInputModelDownloadResult,
  VoiceInputSettings,
  VoiceInputSettingsGetInput,
  VoiceInputSettingsGetResult,
  VoiceInputSettingsUpdateInput,
  VoiceInputSettingsUpdateResult,
  VoiceInputTranscribeInput,
  VoiceInputTranscribeResult,
  VoiceInputTranscriptionTestInput,
  VoiceInputTranscriptionTestResult,
} from "../shared/schema.ts";
import { makeVoiceInputRuntime, type VoiceInputCollections } from "./runtime.ts";

const SETTINGS_COLLECTION = "settings";

export function commandName(name: string) {
  return PluginCommandName.make(name);
}

export const registerVoiceInputCollections = (
  ctx: PluginActivationContext,
): Effect.Effect<VoiceInputCollections, Error> =>
  Effect.gen(function* () {
    const settings = yield* ctx.store.registerCollection(SETTINGS_COLLECTION, VoiceInputSettings);
    return { settings };
  });

export const registerVoiceInputCommands = (
  ctx: PluginActivationContext,
  collections: VoiceInputCollections,
) =>
  Effect.gen(function* () {
    const runtime = yield* makeVoiceInputRuntime(ctx, collections);

    yield* ctx.commands.register(commandName(VOICE_INPUT_COMMANDS.settingsGet), {
      input: VoiceInputSettingsGetInput,
      output: VoiceInputSettingsGetResult,
      handler: () => runtime.getSettingsResult(),
    });

    yield* ctx.commands.register(commandName(VOICE_INPUT_COMMANDS.settingsUpdate), {
      input: VoiceInputSettingsUpdateInput,
      output: VoiceInputSettingsUpdateResult,
      handler: (input) => runtime.updateSettings(input.patch),
    });

    yield* ctx.commands.register(commandName(VOICE_INPUT_COMMANDS.dependenciesStatus), {
      input: VoiceInputDependenciesStatusInput,
      output: VoiceInputDependenciesStatusResult,
      handler: () => runtime.getDependenciesStatus(),
    });

    yield* ctx.commands.register(commandName(VOICE_INPUT_COMMANDS.clientStateGet), {
      input: VoiceInputClientStateGetInput,
      output: VoiceInputClientStateGetResult,
      handler: () => runtime.getClientState(),
    });

    yield* ctx.commands.register(commandName(VOICE_INPUT_COMMANDS.modelDownload), {
      input: VoiceInputModelDownloadInput,
      output: VoiceInputModelDownloadResult,
      handler: () => runtime.downloadModel(),
    });

    yield* ctx.commands.register(commandName(VOICE_INPUT_COMMANDS.transcribe), {
      input: VoiceInputTranscribeInput,
      output: VoiceInputTranscribeResult,
      handler: (input) => runtime.transcribe(input),
    });

    yield* ctx.commands.register(commandName(VOICE_INPUT_COMMANDS.transcriptionTest), {
      input: VoiceInputTranscriptionTestInput,
      output: VoiceInputTranscriptionTestResult,
      handler: () => runtime.testTranscription(),
    });
  });
