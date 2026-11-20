// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { appSchemeDefine, loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_CLERK_JWT_TEMPLATE=template_root\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_local\nT3CODE_CLERK_JWT_TEMPLATE=template_local\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nT3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });
});

describe("loadRepoEnv in a standalone build", () => {
  const fork = {
    T3CODE_STANDALONE: "true",
    GITHUB_REPOSITORY: "fork-owner/t3code",
    T3CODE_APP_SCHEME: "forkcode",
  };

  it("passes the fork's own config through and normalizes the switch", () => {
    expect(
      loadRepoEnv({
        baseEnv: { ...fork, T3CODE_HOSTED_APP_URL: "https://app.fork.example" },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toMatchObject({
      T3CODE_STANDALONE: "1",
      VITE_HOSTED_APP_URL: "https://app.fork.example",
    });
  });

  it.each([
    [{ T3CODE_RELAY_URL: "https://relay.t3.codes" }, "T3CODE_RELAY_URL"],
    [{ VITE_HOSTED_APP_URL: "https://app.t3.codes" }, "T3CODE_HOSTED_APP_URL"],
    [{ EXPO_PUBLIC_OTLP_TRACES_URL: "https://ingest.t3.codes/v1" }, "MOBILE_OTLP"],
    [{ EXPO_PUBLIC_MARKETING_SITE_URL: "https://t3.codes" }, "MARKETING_SITE_URL"],
    [{ T3CODE_EAS_PROJECT_ID: "d763fcb8-d37c-41ea-a773-b54a0ab4a454" }, "T3CODE_EAS_PROJECT_ID"],
    [{ GITHUB_REPOSITORY: "pingdotgg/t3code" }, "pingdotgg/t3code"],
    [{ GITHUB_REPOSITORY: "" }, "owner/repo"],
    [{ T3CODE_APP_SCHEME: "" }, "T3CODE_APP_SCHEME"],
    [{ T3CODE_APP_SCHEME: "t3code-dev" }, "T3CODE_APP_SCHEME"],
  ])("refuses T3-operated config %j", (override, message) => {
    expect(() =>
      loadRepoEnv({ baseEnv: { ...fork, ...override }, repoRoot: makeTemporaryDirectory() }),
    ).toThrow(message);
  });

  it("gets everything it requires from the fork release workflow", () => {
    const Env = Schema.optional(Schema.Record(Schema.String, Schema.String));
    const workflow = Schema.decodeSync(
      fromYaml(
        Schema.Struct({
          jobs: Schema.Struct({
            build: Schema.Struct({
              env: Env,
              steps: Schema.Array(Schema.Struct({ run: Schema.optional(Schema.String), env: Env })),
            }),
          }),
        }),
      ),
    )(
      NodeFS.readFileSync(
        new URL("../../.github/workflows/fork-release.yml", import.meta.url),
        "utf8",
      ),
    );
    const { build } = workflow.jobs;
    const step = build.steps.find((s) => s.run?.includes("build-standalone-linux-cli.sh"));
    expect(step).toBeDefined();
    // Repository variables are the fork's to fill in; any valid value stands in for them here.
    const workflowEnv = Object.fromEntries(
      Object.entries({ ...build.env, ...step?.env }).map(([name, value]) => [
        name,
        value.replace(/\$\{\{\s*vars\.\w+\s*\}\}/g, "forkcode"),
      ]),
    );
    expect(() =>
      loadRepoEnv({
        // What build-standalone-linux-cli.sh exports itself.
        baseEnv: { ...workflowEnv, T3CODE_STANDALONE: "1", GITHUB_REPOSITORY: "fork-owner/t3code" },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).not.toThrow();
  });

  it("leaves the default build's T3 config alone", () => {
    expect(
      loadRepoEnv({
        baseEnv: { T3CODE_RELAY_URL: "https://relay.t3.codes" },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toMatchObject({ T3CODE_RELAY_URL: "https://relay.t3.codes" });
  });
});

describe("appSchemeDefine", () => {
  it("bakes in only a fork's valid scheme", () => {
    expect(appSchemeDefine({})).toEqual({});
    expect(appSchemeDefine({ T3CODE_APP_SCHEME: "t3code" })).toEqual({});
    expect(appSchemeDefine({ T3CODE_APP_SCHEME: "forkcode" })).toEqual({
      __T3CODE_BUILD_APP_SCHEME__: '"forkcode"',
    });
    expect(() => appSchemeDefine({ T3CODE_APP_SCHEME: "Fork Code" })).toThrow("lowercase");
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
