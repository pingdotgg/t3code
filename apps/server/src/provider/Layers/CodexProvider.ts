import type { CodexSettings } from "@t3tools/contracts";
import { Cache, Duration, Effect, Equal, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { CodexProvider } from "../Services/CodexProvider";
import { ServerSettingsService } from "../../serverSettings";
import { checkCodexProviderStatus, probeCodexCapabilities } from "./CodexProvider.shared";

export { getCodexModelCapabilities } from "./CodexProvider.shared";

export const CodexProviderLive = Layer.effect(
  CodexProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const accountProbeCache = yield* Cache.make({
      capacity: 4,
      timeToLive: Duration.minutes(5),
      lookup: (key: string) => {
        const [binaryPath, homePath] = JSON.parse(key) as [string, string | undefined];
        return probeCodexCapabilities({
          binaryPath,
          ...(homePath ? { homePath } : {}),
        });
      },
    });

    const checkProvider = checkCodexProviderStatus((input) =>
      Cache.get(accountProbeCache, JSON.stringify([input.binaryPath, input.homePath])),
    ).pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CodexSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.codex),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.codex),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
