import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL } from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";

import * as ServerSettings from "../serverSettings.ts";

export class VcsAutomaticFetchInterval extends Context.Reference<Effect.Effect<Duration.Duration>>(
  "t3/vcs/VcsAutomaticFetchInterval",
  { defaultValue: () => Effect.succeed(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL) },
) {}

export const layer = Layer.effect(
  VcsAutomaticFetchInterval,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return serverSettings.getSettings.pipe(
      Effect.map(
        (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
      ),
      Effect.orElseSucceed(() => DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL),
    );
  }),
);
