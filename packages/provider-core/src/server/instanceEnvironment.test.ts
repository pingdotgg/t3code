import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  applyProviderSessionEnvironmentOverride,
  mergeProviderInstanceEnvironment,
  ProviderSessionEnvironmentOverride,
  TEAM_GITHUB_SANITIZE_ENV,
} from "./instanceEnvironment.ts";

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
        GROK_HOME: "~/.inherited-grok",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "GROK_HOME", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        GROK_HOME: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
        GROK_HOME: "~/.inherited-grok",
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
            {
              name: "OPENAI_API_KEY",
              value: {
                provider: SecretProviderId.make("personal"),
                reference: "op://Private/OpenAI/credential",
              },
              sensitive: true,
            },
          ],
          { ANTHROPIC_API_KEY: "inherited", OPENAI_API_KEY: "inherited", PATH: "/bin" },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "inherited",
        PATH: "/bin",
      });
    }),
  );

  const appDir = "/tmp/.mount_T3-CodXXXX";
  const systemLibraryPath = "/home/ada/lib:/home/ada/.local/lib";
  it.effect.each([
    {
      label: "without configured variables",
      environment: undefined,
      libraryPath: `${appDir}/usr/lib;${systemLibraryPath}`,
      keptLibraryPath: systemLibraryPath,
    },
    {
      label: "alongside configured variables",
      environment: [{ name: "CUSTOM_VALUE", value: "set", sensitive: false }],
      libraryPath: `${appDir}/usr/lib;${systemLibraryPath}`,
      keptLibraryPath: systemLibraryPath,
    },
    {
      label: "keeping a lone current-directory entry",
      environment: undefined,
      libraryPath: `${appDir}/usr/lib:`,
      keptLibraryPath: ":",
    },
  ])(
    "drops the AppImage runtime from the inherited environment $label",
    ({ environment, libraryPath, keptLibraryPath }) =>
      Effect.gen(function* () {
        const merged = yield* mergeProviderInstanceEnvironment(environment, {
          APPIMAGE: "/home/ada/T3-Code.AppImage",
          APPDIR: appDir,
          ARGV0: "/home/ada/T3-Code.AppImage",
          OWD: "/home/ada",
          PATH: `${appDir}:${appDir}/usr/sbin::/usr/bin`,
          LD_LIBRARY_PATH: libraryPath,
          XDG_DATA_DIRS: `${appDir}/usr/share/:/usr/share`,
          GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
        });

        expect(merged).toEqual({
          PATH: ":/usr/bin",
          LD_LIBRARY_PATH: keptLibraryPath,
          XDG_DATA_DIRS: "/usr/share",
          ...(environment ? { CUSTOM_VALUE: "set" } : {}),
        });
      }),
  );

  it.effect("replaces every inherited spelling of a name on Windows, and only there", () =>
    Effect.gen(function* () {
      const merge = (platform: NodeJS.Platform) =>
        mergeProviderInstanceEnvironment(
          [{ name: "Https_Proxy", value: "http://gateway", sensitive: false }],
          { HTTPS_PROXY: "http://mine", PATH: "/bin" },
        ).pipe(Effect.provideService(HostProcess.Platform, platform));
      // A home variable in another spelling is still expanded.
      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "Codex_Home", value: "~/corp", sensitive: false }],
          {},
        ).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
        ),
      ).toEqual({ CODEX_HOME: "/home/ada/corp" });
      // Upper case sorts first, so it also wins where a spawn merges the parent environment back.
      expect(yield* merge("win32")).toEqual({ HTTPS_PROXY: "http://gateway", PATH: "/bin" });
      expect(yield* merge("linux")).toEqual({
        HTTPS_PROXY: "http://mine",
        Https_Proxy: "http://gateway",
        PATH: "/bin",
      });
    }),
  );

  it.effect(
    "strips all ambient GitHub and GHE credentials on both broker token and fail-closed sanitize sentinel",
    () =>
      Effect.gen(function* () {
        const pollutedBase: NodeJS.ProcessEnv = {
          GH_TOKEN: "host-gh",
          GITHUB_TOKEN: "host-github",
          GH_ENTERPRISE_TOKEN: "host-ghe",
          GITHUB_ENTERPRISE_TOKEN: "host-github-ghe",
          GITHUB_PAT: "host-github-pat",
          github_pat: "mixed-case-pat",
          GH_HOST: "ghe.host.local",
          gh_enterprise_token: "mixed-case-ghe",
          GIT_CONFIG: "/dev/null",
          GIT_CONFIG_SYSTEM: "/etc/gitconfig",
          GIT_CONFIG_PARAMETERS: "'http.extraHeader=Authorization: Basic host'",
          GIT_CONFIG_COUNT: "6",
          GIT_CONFIG_KEY_5: "http.https://github.com/.extraHeader",
          GIT_CONFIG_VALUE_5: "Authorization: Basic STRAY_HOST_SECRET",
          NETRC: "/home/host/.netrc",
          GIT_AUTHOR_NAME: "Host Human",
          GIT_AUTHOR_EMAIL: "human@host.local",
          GIT_COMMITTER_NAME: "Host Human",
          GIT_COMMITTER_EMAIL: "human@host.local",
          SAFE_VAR: "keep",
        };

        // Fail-closed sanitize sentinel (e.g. when broker listener failed to start)
        const failClosed = applyProviderSessionEnvironmentOverride(pollutedBase, {
          [TEAM_GITHUB_SANITIZE_ENV]: "1",
          GIT_TERMINAL_PROMPT: "0",
        });
        expect(failClosed.GH_TOKEN).toBeUndefined();
        expect(failClosed.GITHUB_TOKEN).toBeUndefined();
        expect(failClosed.GH_ENTERPRISE_TOKEN).toBeUndefined();
        expect(failClosed.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
        expect(failClosed.GITHUB_PAT).toBeUndefined();
        expect(failClosed.github_pat).toBeUndefined();
        expect(failClosed.GH_HOST).toBeUndefined();
        expect(failClosed.gh_enterprise_token).toBeUndefined();
        expect(failClosed.GIT_CONFIG).toBeUndefined();
        expect(failClosed.GIT_CONFIG_SYSTEM).toBeUndefined();
        expect(failClosed.GIT_CONFIG_PARAMETERS).toBeUndefined();
        expect(failClosed.GIT_CONFIG_COUNT).toBeUndefined();
        expect(failClosed.GIT_CONFIG_KEY_5).toBeUndefined();
        expect(failClosed.GIT_CONFIG_VALUE_5).toBeUndefined();
        expect(failClosed.NETRC).toBeUndefined();
        expect(failClosed.GIT_AUTHOR_NAME).toBeUndefined();
        expect(failClosed.GIT_COMMITTER_EMAIL).toBeUndefined();
        expect(failClosed.SAFE_VAR).toBe("keep");

        // mergeProviderInstanceEnvironment also strips via ProviderSessionEnvironmentOverride
        const merged = yield* mergeProviderInstanceEnvironment(undefined, pollutedBase).pipe(
          Effect.provideService(ProviderSessionEnvironmentOverride, {
            [TEAM_GITHUB_SANITIZE_ENV]: "1",
            GIT_AUTHOR_NAME: "Alice",
            GIT_AUTHOR_EMAIL: "alice@acme.dev",
          }),
        );
        expect(merged.GH_TOKEN).toBeUndefined();
        expect(merged.GH_ENTERPRISE_TOKEN).toBeUndefined();
        expect(merged.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
        expect(merged.GITHUB_PAT).toBeUndefined();
        expect(merged.github_pat).toBeUndefined();
        expect(merged.GH_HOST).toBeUndefined();
        expect(merged.GIT_AUTHOR_NAME).toBe("Alice");
        expect(merged.GIT_AUTHOR_EMAIL).toBe("alice@acme.dev");

        // ACP flavor second-stage merge (options.environment + processEnvironment: NodeJS.ProcessEnv)
        // must also strip ambient GitHub credentials captured at driver creation time.
        const acpProcessEnv: NodeJS.ProcessEnv = {
          T3_TEAM_GH_SANITIZE: "1",
          T3_TEAM_GH_BROKER_TOKEN: "t3ghs_acp_session",
          T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:9999",
          OPTIONAL_UNSET: undefined,
        };
        const acpMerged = applyProviderSessionEnvironmentOverride(pollutedBase, acpProcessEnv);
        expect(acpMerged.GH_TOKEN).toBeUndefined();
        expect(acpMerged.GITHUB_TOKEN).toBeUndefined();
        expect(acpMerged.GH_ENTERPRISE_TOKEN).toBeUndefined();
        expect(acpMerged.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
        expect(acpMerged.GITHUB_PAT).toBeUndefined();
        expect(acpMerged.github_pat).toBeUndefined();
        expect(acpMerged.GH_HOST).toBeUndefined();
        expect(acpMerged.GIT_AUTHOR_NAME).toBeUndefined();
        expect(acpMerged.T3_TEAM_GH_BROKER_TOKEN).toBe("t3ghs_acp_session");
        expect(acpMerged.SAFE_VAR).toBe("keep");
      }),
  );
});
