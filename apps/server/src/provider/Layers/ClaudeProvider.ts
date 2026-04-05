import type { ClaudeSettings } from "@t3tools/contracts";
import { Cache, Duration, Effect, Equal, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import { ServerSettingsService } from "../../serverSettings";
import {
  checkClaudeProviderStatus,
  getClaudeModelCapabilities,
  probeClaudeCapabilities,
} from "./ClaudeProvider.logic";

export { getClaudeModelCapabilities };

export const ClaudeProviderLive = Layer.effect(
  ClaudeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const subscriptionProbeCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(5),
      lookup: (binaryPath: string) =>
        probeClaudeCapabilities(binaryPath).pipe(Effect.map((r) => r?.subscriptionType)),
    });

    const checkProvider = checkClaudeProviderStatus((binaryPath) =>
      Cache.get(subscriptionProbeCache, binaryPath),
    ).pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<ClaudeSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.claudeAgent),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.claudeAgent),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
