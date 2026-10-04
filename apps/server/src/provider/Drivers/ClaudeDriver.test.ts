import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ResetCreditCoordinator from "../Layers/resetCreditCoordinator.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { installFakeMise } from "../testUtils/fakeMise.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-claude-driver-maintenance-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  // Resolving maintenance never opens a Claude session.
  Layer.provideMerge(Layer.mock(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner)({})),
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

it.layer(testLayer)("ClaudeDriver", (it) => {
  it.effect.each([
    { layout: "native", miseOnPath: false, expected: "claude-update" },
    { layout: "mise wrapper", miseOnPath: false, expected: "manual" },
    { layout: "mise wrapper", miseOnPath: true, expected: "mise-upgrade" },
  ] as const)(
    "resolves updates for a $layout at ~/.local/bin/claude (mise on PATH: $miseOnPath)",
    ({ layout, miseOnPath, expected }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-claude-update-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const binaryPath = path.join(home, ".local", "bin", "claude");
        yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
        const fake = installFakeMise(path.join(home, "mise-bin", "mise"), {
          which: { claude: path.join(home, ".local/share/mise/installs/claude/2.1.5/bin/claude") },
          ls: {
            claude: [
              {
                version: "2.1.5",
                install_path: path.join(home, ".local/share/mise/installs/claude/2.1.5"),
                active: true,
              },
            ],
          },
          outdated: {},
        });
        if (layout === "native") {
          const versionPath = path.join(home, ".local", "share", "claude", "versions", "2.1.0");
          yield* fs.makeDirectory(path.dirname(versionPath), { recursive: true });
          yield* fs.writeFileString(versionPath, "#!/bin/sh\n");
          yield* fs.chmod(versionPath, 0o755);
          yield* fs.symlink(versionPath, binaryPath);
        } else {
          const miseBin = path.join(home, ".local/share/mise/installs/claude/2.1.5/bin/claude");
          yield* fs.makeDirectory(path.dirname(miseBin), { recursive: true });
          yield* fs.writeFileString(miseBin, "#!/bin/sh\n");
          yield* fs.writeFileString(
            binaryPath,
            '#!/bin/bash\nexport MISE_MINIMUM_RELEASE_AGE=0\nmise use -g --quiet "claude" || exit 1\nexec mise x "claude" -- "claude" "$@"\n',
          );
          yield* fs.chmod(binaryPath, 0o755);
        }

        const instance = yield* ClaudeDriver.create({
          instanceId: ProviderInstanceId.make("claude-update"),
          displayName: "Claude test",
          enabled: false,
          environment: [
            { name: "HOME", value: home, sensitive: false },
            {
              name: "PATH",
              value: miseOnPath ? path.dirname(fake.misePath) : "",
              sensitive: false,
            },
          ],
          config: { ...ClaudeDriver.defaultConfig(), binaryPath },
        });

        const update = (yield* instance.snapshot.resolveMaintenance()).update;
        if (expected === "claude-update") {
          expect(update).toMatchObject({ executable: binaryPath, args: ["update"] });
        } else if (expected === "mise-upgrade") {
          expect(update).toMatchObject({
            executable: fake.misePath,
            args: ["upgrade", "--no-prune", "claude"],
          });
        } else {
          // `claude update` would only report that a package manager owns it.
          expect(update).toBeNull();
        }
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );
});
