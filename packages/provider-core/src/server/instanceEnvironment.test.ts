import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves inherited provider homes unchanged", () =>
    Effect.gen(function* () {
      const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          baseEnv,
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
          ],
          { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        PATH: "/bin",
      });
    }),
  );

  it.effect("keeps the AppImage runtime and the Electron-as-Node flag out of agent sessions", () =>
    Effect.gen(function* () {
      const appDir = "/tmp/.mount_T3-Codeabc123";

      expect(
        yield* mergeProviderInstanceEnvironment(undefined, {
          APPIMAGE: "/home/user/T3-Code.AppImage",
          APPDIR: appDir,
          ARGV0: "/home/user/T3-Code.AppImage",
          OWD: "/home/user/project",
          ELECTRON_RUN_AS_NODE: "1",
          PATH: `${appDir}:${appDir}/usr/sbin:/usr/local/bin:/usr/bin`,
          LD_LIBRARY_PATH: `${appDir}/usr/lib`,
          HOME: "/home/user",
        }),
      ).toEqual({ PATH: "/usr/local/bin:/usr/bin", HOME: "/home/user" });
    }),
  );

  it.effect("drops only the Electron-as-Node flag outside an AppImage", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment([], {
          ELECTRON_RUN_AS_NODE: "1",
          OWD: "/home/user/keep-this",
          PATH: "/usr/bin",
        }),
      ).toEqual({ OWD: "/home/user/keep-this", PATH: "/usr/bin" });
    }),
  );

  it.effect("applies provider settings after the scrub", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "ELECTRON_RUN_AS_NODE", value: "1", sensitive: false },
            { name: "APPDIR", value: "/opt/configured", sensitive: false },
          ],
          {
            APPIMAGE: "/home/user/T3-Code.AppImage",
            APPDIR: "/tmp/.mount_T3-x",
            PATH: "/usr/bin",
          },
        ),
      ).toEqual({ ELECTRON_RUN_AS_NODE: "1", APPDIR: "/opt/configured", PATH: "/usr/bin" });
    }),
  );
});
