import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HostProcessPlatform } from "./hostProcess.ts";
import { loadManagedSettings, MANAGED_PREFERENCES_DOMAIN } from "./managedSettings.ts";

it.layer(NodeServices.layer)("managed settings loading", (it) => {
  it.effect("layers sources by precedence, merging nested objects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-sources-" });
      const lower = path.join(directory, "lower.json");
      const higher = path.join(directory, "higher.json");
      yield* fs.writeFileString(
        lower,
        JSON.stringify({
          enableAgentBrowserAccess: true,
          defaultAutoPull: true,
          providers: { codex: { homePath: "/lower/.codex" } },
        }),
      );
      yield* fs.writeFileString(
        higher,
        JSON.stringify({
          enableAgentBrowserAccess: false,
          providers: { codex: { binaryPath: "/higher/bin/codex" } },
          providerInstances: { codex: { driver: "codex", enabled: false } },
        }),
      );

      const policy = yield* loadManagedSettings([
        { kind: "json", path: lower },
        { kind: "json", path: path.join(directory, "missing.json") },
        { kind: "json", path: higher },
      ]);

      assert.deepEqual(policy.document, {
        enableAgentBrowserAccess: false,
        defaultAutoPull: true,
        providers: { codex: { homePath: "/lower/.codex", binaryPath: "/higher/bin/codex" } },
        providerInstances: { codex: { driver: "codex", enabled: false } },
      });
      assert.deepEqual(policy.paths, [
        ["enableAgentBrowserAccess"],
        ["defaultAutoPull"],
        ["providers", "codex", "homePath"],
        ["providers", "codex", "binaryPath"],
        ["providerInstances", "codex", "driver"],
        ["providerInstances", "codex", "enabled"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails instead of enforcing part of an invalid policy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-invalid-" });
      const valid = path.join(directory, "valid.json");
      const invalid = path.join(directory, "invalid.json");
      const broken = path.join(directory, "broken.json");
      yield* fs.writeFileString(valid, JSON.stringify({ enableAgentBrowserAccess: false }));
      yield* fs.writeFileString(
        invalid,
        JSON.stringify({
          enableAgentBrowserAccess: false,
          defaultRuntimeMode: "not-a-mode",
          notASetting: true,
          observability: { otlpTracesUrl: "http://corp.test/traces" },
        }),
      );
      yield* fs.writeFileString(broken, "{ not json");

      const invalidError = yield* loadManagedSettings([
        { kind: "json", path: valid },
        { kind: "json", path: invalid },
      ]).pipe(Effect.flip);
      assert.equal(invalidError.path, invalid);
      assert.equal(
        invalidError.detail,
        'invalid value for "defaultRuntimeMode", unknown key "notASetting"',
      );

      const brokenError = yield* loadManagedSettings([{ kind: "json", path: broken }]).pipe(
        Effect.flip,
      );
      assert.equal(brokenError.path, broken);
      assert.equal(brokenError.detail, "not a JSON object");
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() !== "darwin")(
    "reads a binary MDM plist",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-plist-" });
        const plist = path.join(directory, `${MANAGED_PREFERENCES_DOMAIN}.plist`);
        yield* fs.writeFileString(
          plist,
          JSON.stringify({
            enableAgentBrowserAccess: false,
            providers: { codex: { binaryPath: "/mdm/bin/codex" } },
          }),
        );
        // Configuration profiles install binary plists.
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner.exitCode(
          ChildProcess.make("/usr/bin/plutil", ["-convert", "binary1", plist], { stdin: "ignore" }),
        );

        const policy = yield* loadManagedSettings([{ kind: "plist", path: plist }]);

        assert.deepEqual(policy.document, {
          enableAgentBrowserAccess: false,
          providers: { codex: { binaryPath: "/mdm/bin/codex" } },
        });
      }).pipe(Effect.scoped),
  );
});
