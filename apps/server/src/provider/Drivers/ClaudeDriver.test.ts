import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ResetCreditCoordinator from "../Layers/resetCreditCoordinator.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-claude-driver-maintenance-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Claude must not make an HTTP request")),
    ),
  ),
);

// These write `#!/bin/sh` stubs and symlinks, which Windows cannot resolve.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Claude must not spawn a process"),
);

it.layer(testLayer)("ClaudeDriver", (it) => {
  for (const layout of ["native", "wrapper"] as const) {
    it.effect.skipIf(windowsHost)(`resolves updates for a ${layout} ~/.local/bin/claude`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: `t3-claude-${layout}-` });
        const binaryPath = path.join(home, ".local", "bin", "claude");
        yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
        if (layout === "native") {
          const versionPath = path.join(home, ".local", "share", "claude", "versions", "2.1.0");
          yield* fs.makeDirectory(path.dirname(versionPath), { recursive: true });
          yield* fs.writeFileString(versionPath, "#!/bin/sh\n");
          yield* fs.chmod(versionPath, 0o755);
          yield* fs.symlink(versionPath, binaryPath);
        } else {
          yield* fs.writeFileString(
            binaryPath,
            '#!/bin/bash\nexec "$HOME/.local/share/mise/shims/claude" "$@"\n',
          );
          yield* fs.chmod(binaryPath, 0o755);
        }

        const instance = yield* ClaudeDriver.create({
          instanceId: ProviderInstanceId.make(`claude-${layout}`),
          displayName: "Claude test",
          enabled: false,
          environment: [],
          config: { ...ClaudeDriver.defaultConfig(), binaryPath },
        });

        const update = (yield* instance.snapshot.resolveMaintenance()).update;
        if (layout === "native") {
          expect(update).toMatchObject({ executable: binaryPath, args: ["update"] });
        } else {
          expect(update).toBeNull();
        }
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
    );
  }
});
