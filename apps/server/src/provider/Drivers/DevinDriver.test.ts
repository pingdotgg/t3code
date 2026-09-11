// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { DevinDriver } from "./DevinDriver.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-devin-driver-skills-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const makeSkillsBinary = Effect.fn("makeDevinSkillsBinary")(function* (options: {
  readonly skillsJson: string;
  readonly skillsExitCode?: number;
}) {
  const dir = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-driver-skills-")),
  );
  const binaryPath = NodePath.join(dir, "fake-devin.sh");
  const skillsJsonPath = NodePath.join(dir, "skills.json");
  yield* Effect.promise(() => NodeFSP.writeFile(skillsJsonPath, options.skillsJson, "utf8"));
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "devin 1.0.0"
  exit 0
fi
if [ "$1" = "skills" ]; then
  cat '${skillsJsonPath}'
  exit ${options.skillsExitCode ?? 0}
fi
echo "unexpected command: $*" >&2
exit 1
`;
  yield* Effect.promise(() => NodeFSP.writeFile(binaryPath, script, "utf8"));
  yield* Effect.promise(() => NodeFSP.chmod(binaryPath, 0o755));
  return binaryPath;
});

const createInstance = (binaryPath: string, enabled: boolean) =>
  DevinDriver.create({
    instanceId: ProviderInstanceId.make("devin-skills-test"),
    displayName: "Devin skills test",
    enabled,
    environment: [],
    config: { ...DevinDriver.defaultConfig(), binaryPath, enabled },
  });

it.layer(testLayer)("DevinDriver snapshotForCwd", (it) => {
  it.effect("returns the normal snapshot without discovery when Devin is disabled", () =>
    Effect.gen(function* () {
      const noSpawn = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.die("Disabled Devin must not spawn a skills process"),
        ),
      );
      const instance = yield* createInstance("devin-unused", false).pipe(Effect.provide(noSpawn));
      const snapshot = yield* instance.snapshotForCwd!("/workspace");

      expect(snapshot.skills).toEqual([]);
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.supportsConversationRollback).toBe(false);
    }),
  );

  it.effect.skipIf(windowsHost)("includes discovered skills in the workspace snapshot", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeSkillsBinary({
        skillsJson: encodeUnknownJson([
          {
            name: "deploy",
            base_dir: "/tmp/skills/deploy",
            description: "Deploy the app.",
            triggers: ["user", "model"],
          },
        ]),
      });
      const instance = yield* createInstance(binaryPath, true);
      const snapshot = yield* instance.snapshotForCwd!("/workspace");

      expect(snapshot.skills).toHaveLength(1);
      expect(snapshot.skills[0]).toMatchObject({ name: "deploy", enabled: true });
    }),
  );

  it.effect.skipIf(windowsHost)(
    "fails with a typed error so the registry keeps the last valid snapshot",
    () =>
      Effect.gen(function* () {
        const binaryPath = yield* makeSkillsBinary({
          skillsJson: "[]",
          skillsExitCode: 3,
        });
        const instance = yield* createInstance(binaryPath, true);
        const exit = yield* Effect.exit(instance.snapshotForCwd!("/workspace"));

        expect(Exit.isFailure(exit)).toBe(true);
      }),
  );
});
