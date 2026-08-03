/**
 * SystemPromptResolver - fork feature f2.
 *
 * Thin server-side wrapper over the pure resolver in `@t3tools/contracts`, so
 * `ProviderService` acquires one dependency instead of inlining a settings
 * read. Settings are re-read per call: an edited rule affects the next session
 * with no server restart.
 *
 * A settings read failure resolves to "no instructions" rather than failing the
 * session — an unreadable settings file must not stop a user from working.
 *
 * @module SystemPromptResolver
 */
import { resolveSystemPromptInjection, type SystemPromptTarget } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../serverSettings.ts";

export class SystemPromptResolver extends Context.Service<
  SystemPromptResolver,
  {
    readonly resolve: (target: SystemPromptTarget) => Effect.Effect<string | undefined>;
  }
>()("t3/provider/SystemPromptResolver") {}

export const layer = Layer.effect(
  SystemPromptResolver,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;

    const resolve = Effect.fn("SystemPromptResolver.resolve")(function* (
      target: SystemPromptTarget,
    ) {
      const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
      if (settings === null) {
        return undefined;
      }
      return resolveSystemPromptInjection(settings.systemPromptInjection, target);
    });

    return SystemPromptResolver.of({ resolve });
  }),
);

/** Fixed-answer resolver for tests. Defaults to injecting nothing. */
export const layerTest = (instructions?: string) =>
  Layer.succeed(
    SystemPromptResolver,
    SystemPromptResolver.of({ resolve: () => Effect.succeed(instructions) }),
  );
