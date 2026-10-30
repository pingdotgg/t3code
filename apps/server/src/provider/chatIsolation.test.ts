import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";

import { resolveChatIsolationConfig } from "./chatIsolation.ts";
import { materializeCodexShadowHome, resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

it.layer(NodeServices.layer)("chat isolation", (it) => {
  it.effect(
    "keeps Codex state out of the shared and shadow homes without changing saved config",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const config = {
          ...decodeCodexSettings({
            homePath: path.join(root, "desktop"),
            shadowHomePath: path.join(root, "account"),
            launchArgs: '-c model="gpt-6-luna"',
          }),
          isolateChats: true,
        };
        const effective = resolveChatIsolationConfig(config, "codex", "work", root, path);
        const layout = yield* resolveCodexHomeLayout(effective);
        expect(layout.mode).toBe("direct");
        const managedLayout = yield* resolveManagedCodexHomeLayout(
          root,
          ProviderInstanceId.make("work"),
          config,
        );
        expect(managedLayout).toEqual(layout);
        yield* materializeCodexShadowHome(layout);
        expect(layout.sharedHomePath).toBe(
          path.join(root, "providers", "codex", "work", "isolated-home"),
        );
        expect(layout.continuationKey).not.toBe(
          (yield* resolveCodexHomeLayout(config)).continuationKey,
        );
        expect(effective.launchArgs).toBe(config.launchArgs);
        expect(config.shadowHomePath).toBe(path.join(root, "account"));
        expect(yield* fs.exists(config.homePath)).toBe(false);
        expect(yield* fs.exists(config.shadowHomePath)).toBe(false);
        expect(
          resolveChatIsolationConfig(
            { ...config, isolateChats: false },
            "codex",
            "work",
            root,
            path,
          ).homePath,
        ).toBe(config.homePath);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "scopes supported homes by environment and instance and leaves other providers alone",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const config = { isolateChats: true, homePath: "/shared", binaryPath: "claude" };
        const home = (driver: string, instanceId: string, stateDir: string) =>
          resolveChatIsolationConfig(config, driver, instanceId, stateDir, path).homePath;
        expect(home("claudeAgent", "work", "/one")).not.toBe(config.homePath);
        expect(home("claudeAgent", "work", "/one")).not.toBe(
          home("claudeAgent", "personal", "/one"),
        );
        expect(home("claudeAgent", "work", "/one")).not.toBe(home("claudeAgent", "work", "/two"));
        expect(home("opencode", "work", "/one")).toBe(config.homePath);
        const legacy = { homePath: "/shared" };
        expect(resolveChatIsolationConfig(legacy, "codex", "work", "/one", path)).toBe(legacy);
      }),
  );
});
