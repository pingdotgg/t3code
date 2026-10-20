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

  it.effect("scrubs the inherited AppImage environment before applying provider overrides", () =>
    Effect.gen(function* () {
      const appDir = "/tmp/.mount_T3-Codeabc123";
      const baseEnv = Object.freeze({
        APPIMAGE: "/home/user/T3-Code.AppImage",
        APPDIR: appDir,
        ARGV0: "/home/user/T3-Code.AppImage",
        OWD: "/home/user/project",
        ELECTRON_RUN_AS_NODE: "1",
        PATH: `:${appDir}:${appDir}/usr/bin:/usr/bin::`,
        LD_LIBRARY_PATH: `${appDir}/usr/lib`,
        XDG_DATA_DIRS: `${appDir}/usr/share:/usr/share`,
        GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
        HOME: "/home/user",
      });
      const userEnv = { PATH: "/usr/bin", XDG_DATA_DIRS: "/usr/share", HOME: "/home/user" };

      expect(yield* mergeProviderInstanceEnvironment(undefined, baseEnv)).toEqual(userEnv);
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "ELECTRON_RUN_AS_NODE", value: "1", sensitive: false },
            { name: "APPDIR", value: "/opt/configured", sensitive: false },
            { name: "PATH", value: ":/opt/provider/bin:", sensitive: false },
          ],
          baseEnv,
        ),
      ).toEqual({
        ...userEnv,
        ELECTRON_RUN_AS_NODE: "1",
        APPDIR: "/opt/configured",
        PATH: ":/opt/provider/bin:",
      });
    }),
  );

  it.effect("removes incidental Electron mode without scrubbing a non-AppImage environment", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment([], {
          ELECTRON_RUN_AS_NODE: "1",
          ARGV0: "custom-shell",
          OWD: "/home/user/project",
          PATH: ":/usr/bin::",
        }),
      ).toEqual({ ARGV0: "custom-shell", OWD: "/home/user/project", PATH: ":/usr/bin::" });
    }),
  );
});
