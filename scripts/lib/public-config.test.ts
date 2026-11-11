// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

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
      "T3CODE_MOBILE_OTLP_TRACES_URL=https://root.example.test\nT3CODE_MOBILE_OTLP_TRACES_DATASET=root\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_MOBILE_OTLP_TRACES_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot })).toMatchObject({
      T3CODE_MOBILE_OTLP_TRACES_URL: "https://local.example.test",
      EXPO_PUBLIC_OTLP_TRACES_DATASET: "root",
    });
    expect(
      loadRepoEnv({
        baseEnv: { EXPO_PUBLIC_OTLP_TRACES_URL: "https://ci.example.test" },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_MOBILE_OTLP_TRACES_URL: "https://ci.example.test",
      EXPO_PUBLIC_OTLP_TRACES_URL: "https://ci.example.test",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
