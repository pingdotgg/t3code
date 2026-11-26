import { providerProcessEnvironment } from "@t3tools/provider-core/server/providerTelemetry";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeRuntime,
  materializeClaudeHome,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    for (const shareProfile of [true, false]) {
      it.effect.skipIf(!symlinksSupported)(
        `keeps private accounts separate with shareProfile=${shareProfile}`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
            const shared = path.join(root, "shared");
            const runtime = yield* resolveClaudeRuntime({
              instanceId: ProviderInstanceId.make("private"),
              stateDir: root,
              config: decodeClaudeSettings({
                setupMode: "cli",
                homePath: "/ignored",
                shareProfile,
              }),
              environment: {
                CLAUDE_CONFIG_DIR: shared,
                ANTHROPIC_API_KEY: "host",
                CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
              },
            });
            const accountDir = path.join(root, "providers", "claude", "private", "cli");
            expect(runtime.config.homePath).toBe(accountDir);
            expect(runtime.environment).toEqual({
              CLAUDE_CONFIG_DIR: accountDir,
              CLAUDE_SECURESTORAGE_CONFIG_DIR: accountDir,
            });
            expect(yield* makeClaudeContinuationGroupKey(runtime.config, runtime.environment)).toBe(
              `claude:home:${accountDir}`,
            );
            // Skills bind to an account; plugins can sync before the account is bound.
            const buckets = {
              skills: "11111111-1111-1111-1111-111111111111_22222222-2222-2222-2222-222222222222",
              plugins: "11111111-1111-1111-1111-111111111111_unbound",
            } as const;
            for (const name of ["plugins", "skills"] as const) {
              const bucket = buckets[name];
              yield* fs.makeDirectory(path.join(accountDir, name, "synced", bucket), {
                recursive: true,
              });
              yield* fs.writeFileString(
                path.join(accountDir, name, "synced", bucket, "skill.md"),
                "skill",
              );
              yield* fs.writeFileString(
                path.join(accountDir, name, "synced", `.bucket-${bucket}`),
                "marker",
              );
            }
            // Only a profile directory that exists gets a link; agents stays absent.
            for (const name of ["commands", "output-styles", "rules", "hooks"]) {
              yield* fs.makeDirectory(path.join(shared, name), { recursive: true });
            }
            yield* materializeClaudeHome(runtime);
            if (shareProfile) {
              expect(yield* fs.exists(path.join(accountDir, "agents"))).toBe(false);
              expect(yield* fs.exists(path.join(shared, "agents"))).toBe(false);
              for (const name of [
                "plugins",
                "skills",
                "commands",
                "output-styles",
                "rules",
                "hooks",
                "settings.json",
                "CLAUDE.md",
                "keybindings.json",
              ]) {
                expect(yield* fs.readLink(path.join(accountDir, name))).toBe(
                  path.join(shared, name),
                );
              }
              expect(yield* fs.exists(path.join(shared, "settings.json"))).toBe(false);
              for (const name of ["plugins", "skills"] as const) {
                const bucket = buckets[name];
                expect(
                  yield* fs.readFileString(path.join(shared, name, "synced", bucket, "skill.md")),
                ).toBe("skill");
                expect(
                  yield* fs.readFileString(path.join(shared, name, "synced", `.bucket-${bucket}`)),
                ).toBe("marker");
              }
              if (runtime.mode !== "cli") throw new Error("Expected CLI runtime");
              yield* materializeClaudeHome({
                ...runtime,
                overlay: { ...runtime.overlay, active: false },
              });
              expect(yield* fs.readDirectory(accountDir)).toEqual([]);
            }
            expect(yield* fs.exists(path.join(accountDir, "projects"))).toBe(false);
            expect(yield* fs.readDirectory(accountDir)).toEqual(
              shareProfile ? [] : ["plugins", "skills"],
            );
          }),
      );
    }

    it.effect.skipIf(!symlinksSupported)("retains personal skills in an inference home", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-inference-" });
        const personal = path.join(root, "personal");
        const routed = path.join(root, "routed");
        const skill = (home: string, name: string) => path.join(home, "skills", name, "SKILL.md");
        for (const [home, name, body] of [
          [personal, "review", "Personal review"],
          [personal, "existing", "Personal copy"],
          [routed, "existing", "Routed copy"],
        ] as const) {
          yield* fs.makeDirectory(path.dirname(skill(home, name)), { recursive: true });
          yield* fs.writeFileString(skill(home, name), body);
        }
        yield* fs.writeFileString(path.join(personal, "settings.json"), "{}");

        const runtime = yield* resolveClaudeRuntime({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          stateDir: root,
          config: decodeClaudeSettings({ setupMode: "inference", homePath: routed }),
          environment: { CLAUDE_CONFIG_DIR: routed },
          nativeEnvironment: { CLAUDE_CONFIG_DIR: personal },
        }).pipe(Effect.provideService(HostProcess.Environment, {}));
        yield* materializeClaudeHome(runtime);
        expect(yield* fs.readFileString(skill(routed, "existing"))).toBe("Routed copy");
        expect(yield* fs.exists(path.join(routed, "settings.json"))).toBe(false);
        expect(
          (yield* discoverClaudeSkills(runtime.config, undefined, runtime.environment)).map(
            ({ name }) => name,
          ),
        ).toEqual(["existing", "review"]);
        expect(yield* fs.readFileString(skill(routed, "review"))).toBe("Personal review");
        yield* fs.symlink(
          path.dirname(skill(personal, "existing")),
          path.dirname(skill(routed, "manual")),
        );
        const alternate = path.join(root, "alternate");
        yield* fs.makeDirectory(path.dirname(skill(alternate, "review")), { recursive: true });
        yield* fs.writeFileString(skill(alternate, "review"), "Alternate review");
        const switched = yield* resolveClaudeRuntime({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          stateDir: root,
          config: decodeClaudeSettings({
            setupMode: "inference",
            homePath: routed,
            inferenceSkillsHomePath: alternate,
          }),
          environment: { CLAUDE_CONFIG_DIR: routed },
        });
        yield* materializeClaudeHome(switched);
        expect(yield* fs.readFileString(skill(routed, "review"))).toBe("Alternate review");
        yield* fs.remove(path.dirname(skill(alternate, "review")), { recursive: true });
        yield* materializeClaudeHome(switched);
        expect((yield* fs.readDirectory(path.join(routed, "skills"))).sort()).toEqual([
          "existing",
          "manual",
        ]);
        expect(yield* fs.readFileString(skill(routed, "manual"))).toBe("Personal copy");
        yield* materializeClaudeHome(runtime);
        const privateRuntime = yield* resolveClaudeRuntime({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          stateDir: root,
          config: decodeClaudeSettings({
            setupMode: "inference",
            homePath: routed,
            shareProfile: false,
          }),
          environment: { CLAUDE_CONFIG_DIR: routed },
          nativeEnvironment: { CLAUDE_CONFIG_DIR: personal },
        });
        yield* materializeClaudeHome(privateRuntime);
        expect(yield* fs.exists(skill(routed, "review"))).toBe(false);
        expect(yield* fs.readFileString(skill(routed, "manual"))).toBe("Personal copy");
      }),
    );

    it.effect("gives a symlinked Claude home the continuation key of its target", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const target = path.join(root, ".claude");
        const link = path.join(root, ".claude-second-account");
        yield* fileSystem.makeDirectory(target);
        yield* fileSystem.symlink(target, link);

        const direct = yield* makeClaudeContinuationGroupKey({ homePath: target });
        expect(yield* makeClaudeContinuationGroupKey({ homePath: link })).toBe(direct);
        expect(
          yield* makeClaudeContinuationGroupKey({ homePath: "" }, { CLAUDE_CONFIG_DIR: link }),
        ).toBe(direct);
        // The spawned process keeps the literal path, because Claude keys its login by that path.
        expect((yield* makeClaudeEnvironment({ homePath: link })).CLAUDE_CONFIG_DIR).toBe(link);
      }).pipe(Effect.scoped),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });

  it.effect(
    "drops the launching Claude session and Electron's run-as-Node flag, and labels processes t3-code unless overridden",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
        const host = {
          CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "host-session",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/host-claude.sock",
          CLAUDE_EFFORT: "high",
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "1",
        };
        const instance = [
          { name: "CLAUDE_CODE_ENTRYPOINT", value: "instance", sensitive: false },
          { name: "CLAUDE_EFFORT", value: "low", sensitive: false },
        ];

        const routed = yield* mergeClaudeProcessEnvironment(
          { homePath, setupMode: "inference" },
          [{ name: "ANTHROPIC_BASE_URL", value: "http://route", sensitive: false }],
          {
            ...host,
            Anthropic_Custom_Headers: "host-headers",
            Claude_Code_Use_Bedrock: "1",
            ANTHROPIC_MODEL: "host-model",
            Claude_Config_Dir: "host-home",
          },
        );
        expect(routed).toEqual({
          ...providerProcessEnvironment({}, "linux"),
          CLAUDE_CODE_ENTRYPOINT: "t3-code",
          KEEP: "1",
          ANTHROPIC_BASE_URL: "http://route",
          CLAUDE_CONFIG_DIR: homePath,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: homePath,
        });
        expect(yield* mergeClaudeProcessEnvironment({ homePath }, undefined, host)).toEqual({
          ...providerProcessEnvironment({}, "linux"),
          CLAUDE_CODE_ENTRYPOINT: "t3-code",
          KEEP: "1",
        });
        expect(yield* mergeClaudeProcessEnvironment({ homePath }, instance, host)).toEqual({
          ...providerProcessEnvironment({}, "linux"),
          CLAUDE_CODE_ENTRYPOINT: "instance",
          CLAUDE_EFFORT: "low",
          KEEP: "1",
        });

        yield* fileSystem.writeFileString(
          path.join(homePath, "settings.json"),
          JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: "custom" } }),
        );
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath }, instance, host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("custom");
      }),
  );
});
