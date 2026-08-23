import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/contracts";

import { buildInitialGrokProviderSnapshot, checkGrokProviderStatus } from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — Grok is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken grok install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-version-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-success-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "grok-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );

  it.effect("includes inspect skills and slash commands when ACP discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-inspect-" });
          const workspace = path.join(dir, "repo");
          yield* fs.makeDirectory(workspace, { recursive: true });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            path.join(dir, "inspect.json"),
            // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed harness-owned fixture document.
            JSON.stringify({
              skills: [
                {
                  name: "create-skill",
                  description: "Create a new Grok skill",
                  source: { type: "bundled", path: "/bundled/create-skill/SKILL.md" },
                  userInvocable: true,
                },
                {
                  name: "docx",
                  description: "Word documents",
                  source: { type: "bundled", path: "/bundled/docx/SKILL.md" },
                  userInvocable: false,
                },
              ],
            }),
          );
          yield* fs.writeFileString(
            grokPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "inspect" ]; then',
              '  cat "$(dirname "$0")/inspect.json"',
              "  exit 0",
              "fi",
              'printf "grok-cli 0.0.99\\n"',
              "exit 0",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            { environment: process.env, skillCwds: workspace },
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("ACP startup failed");
      expect(snapshot.skills.map((skill) => skill.name).sort()).toEqual(["create-skill", "docx"]);
      expect(snapshot.skills.find((skill) => skill.name === "create-skill")?.scope).toBe("bundled");
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["create-skill"]);
    }),
  );

  it.effect("falls back to filesystem skills when inspect JSON has no skills array", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-noskills-" });
          const workspace = path.join(dir, "repo");
          yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
          const skillDir = path.join(workspace, ".grok", "skills", "fs-only");
          yield* fs.makeDirectory(skillDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(skillDir, "SKILL.md"),
            "---\nname: fs-only\ndescription: Filesystem project skill.\n---\n",
          );
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "inspect" ]; then',
              "  printf '%s\\n' '{\"grokVersion\":\"1.0.4\"}'",
              "  exit 0",
              "fi",
              'printf "grok-cli 0.0.99\\n"',
              "exit 0",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            { environment: process.env, skillCwds: workspace },
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.skills.some((skill) => skill.name === "fs-only")).toBe(true);
      expect(snapshot.slashCommands).toEqual([]);
    }),
  );

  it.effect("does not spawn inspect when Grok is disabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-disabled-" });
          const workspace = path.join(dir, "repo");
          yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
          const marker = path.join(dir, "inspect-ran");
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "inspect" ]; then',
              `  printf ran > "${marker}"`,
              "  exit 0",
              "fi",
              'printf "grok-cli 0.0.99\\n"',
              "exit 0",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          const result = yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: false, binaryPath: grokPath }),
            { environment: process.env, skillCwds: workspace },
          );
          const inspectRan = yield* fs.exists(marker);
          expect(inspectRan).toBe(false);
          return result;
        }),
      );

      expect(snapshot.status).toBe("disabled");
      expect(snapshot.slashCommands).toEqual([]);
    }),
  );
});
