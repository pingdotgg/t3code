// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv, resolvePublicConfig } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("does not project cloud configuration for an unconfigured clone", () => {
    const env = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });

    expect(env.MORECODE_T3CODE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.MORECODE_T3CODE_CLERK_CLI_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.MORECODE_T3CODE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.VITE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.MORECODE_T3CODE_RELAY_URL).toBeUndefined();
    expect(env.VITE_MORECODE_T3CODE_RELAY_URL).toBeUndefined();
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    writeFileSync(
      join(repoRoot, ".env"),
      "MORECODE_T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nMORECODE_T3CODE_CLERK_JWT_TEMPLATE=template_root\nMORECODE_T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nMORECODE_T3CODE_RELAY_URL=https://root.example.test\n",
    );
    writeFileSync(
      join(repoRoot, ".env.local"),
      "MORECODE_T3CODE_CLERK_PUBLISHABLE_KEY=pk_local\nMORECODE_T3CODE_CLERK_JWT_TEMPLATE=template_local\nMORECODE_T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nMORECODE_T3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).MORECODE_T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          MORECODE_T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          MORECODE_T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
          MORECODE_T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          MORECODE_T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      MORECODE_T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      MORECODE_T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      MORECODE_T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      MORECODE_T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_MORECODE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });

  it("accepts legacy framework aliases as root overrides", () => {
    expect(
      resolvePublicConfig({
        VITE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
        VITE_CLERK_JWT_TEMPLATE: "template_legacy",
        MORECODE_T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_canonical",
        VITE_MORECODE_T3CODE_RELAY_URL: "https://legacy.example.test",
      }),
    ).toEqual({
      clerkPublishableKey: "pk_legacy",
      clerkJwtTemplate: "template_legacy",
      clerkCliOAuthClientId: "oauth_canonical",
      relayUrl: "https://legacy.example.test",
    });
  });

  it("projects only the configured aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          MORECODE_T3CODE_RELAY_URL: "https://relay.example.test",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      MORECODE_T3CODE_RELAY_URL: "https://relay.example.test",
      VITE_MORECODE_T3CODE_RELAY_URL: "https://relay.example.test",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
