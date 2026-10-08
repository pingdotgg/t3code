/**
 * A `ProviderHost` for driver and adapter tests. Its directories live in a
 * scoped temp directory, settings are fixed, and background work always runs
 * unless the test says otherwise.
 *
 * @module provider-testing/host
 */
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

export interface TestProviderHostOptions {
  /** Session fallback cwd. Defaults to the test process cwd. */
  readonly cwd?: string;
  readonly settings?: ServerSettings;
  /** Whether background work such as status probes may run. Defaults to `true`. */
  readonly runBackgroundWork?: boolean;
}

export const layerTestProviderHost = (
  options: TestProviderHostOptions = {},
): Layer.Layer<ProviderHost, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    ProviderHost,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-provider-host-" })
        .pipe(Effect.orDie);
      const stateDir = path.join(baseDir, "userdata");
      const providerStatusCacheDir = path.join(baseDir, "caches");
      const attachmentsDir = path.join(stateDir, "attachments");
      for (const directory of [stateDir, providerStatusCacheDir, attachmentsDir]) {
        yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);
      }
      const settings = options.settings ?? DEFAULT_SERVER_SETTINGS;
      return ProviderHost.of({
        paths: { cwd: options.cwd ?? process.cwd(), baseDir, stateDir, providerStatusCacheDir },
        settings: {
          get: Effect.succeed(settings),
          changes: Stream.empty,
          subscribe: Effect.succeed(Stream.empty),
        },
        shouldRunBackgroundWork: () => Effect.succeed(options.runBackgroundWork ?? true),
        // Tests store attachments flat under the attachments directory by id.
        resolveAttachmentPath: (attachment) => path.join(attachmentsDir, attachment.id),
      });
    }),
  );
