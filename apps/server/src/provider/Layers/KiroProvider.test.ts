import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { KiroSettings } from "@t3tools/contracts";

import {
  buildInitialKiroProviderSnapshot,
  checkKiroProviderStatus,
  parseKiroModelsCliOutput,
  parseKiroWhoamiOutput,
} from "./KiroProvider.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

const LOGGED_IN_WHOAMI = '{"accountType":"SocialGoogle","email":"dev@example.com"}\n';
const LIST_MODELS_OUTPUT = JSON.stringify({
  models: [
    { model_name: "auto", model_id: "auto", context_window_tokens: 1_000_000 },
    { model_name: "claude-sonnet-4.5", model_id: "claude-sonnet-4.5", rate_multiplier: 1.3 },
    { model_name: "claude-haiku-4.5", model_id: "claude-haiku-4.5", rate_multiplier: 0.4 },
  ],
});

describe("parseKiroWhoamiOutput", () => {
  it("reads the signed-in account from the JSON form", () => {
    expect(parseKiroWhoamiOutput(LOGGED_IN_WHOAMI)).toEqual({
      status: "authenticated",
      type: "cached_token",
      label: "Kiro account",
      email: "dev@example.com",
    });
    expect(parseKiroWhoamiOutput('{"accountType":"BuilderId"}').email).toBeUndefined();
  });

  it("detects the logged-out text and leaves anything else unknown", () => {
    expect(parseKiroWhoamiOutput("Not logged in\n").status).toBe("unauthenticated");
    expect(parseKiroWhoamiOutput("kiro-cli 2.23.1").status).toBe("unknown");
  });
});

describe("parseKiroModelsCliOutput", () => {
  it("lists the CLI's models with auto as the default", () => {
    const models = parseKiroModelsCliOutput(LIST_MODELS_OUTPUT);
    expect(models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["auto", true],
      ["claude-sonnet-4.5", false],
      ["claude-haiku-4.5", false],
    ]);
    expect(models[0]?.name).toBe("Auto");
    expect(parseKiroModelsCliOutput("not json")).toEqual([]);
  });
});

describe("buildInitialKiroProviderSnapshot", () => {
  it.effect("returns a disabled snapshot by default — Kiro is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(decodeKiroSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(
        decodeKiroSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("Checking Kiro");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
      expect(snapshot.showInteractionModeToggle).toBe(false);
    }),
  );
});

it.layer(NodeServices.layer)("checkKiroProviderStatus", (it) => {
  // A stand-in for the Kiro CLI: `--version`, `whoami`, and `chat --list-models` print canned text.
  const writeFakeKiroCli = (input: {
    readonly whoami: { readonly stdout: string; readonly stderr?: string; readonly code?: number };
    readonly models: { readonly stdout: string; readonly stderr?: string; readonly code?: number };
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kiro-probe-" });
      const respond = (output: { stdout: string; stderr?: string; code?: number }) => [
        `  process.stdout.write(${JSON.stringify(output.stdout)});`,
        `  process.stderr.write(${JSON.stringify(output.stderr ?? "")});`,
        `  process.exit(${output.code ?? 0});`,
      ];
      return writeFakeCli({
        directory: dir,
        name: "kiro-cli",
        source: [
          'if (process.argv[2] === "--version") {',
          '  process.stdout.write("kiro-cli 2.23.1\\n");',
          "  process.exit(0);",
          "}",
          'if (process.argv[2] === "whoami") {',
          ...respond(input.whoami),
          "}",
          'if (process.argv[2] === "chat" && process.argv[3] === "--list-models") {',
          ...respond(input.models),
          "}",
          "process.exit(1);",
          "",
        ].join("\n"),
      });
    });

  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKiroProviderStatus(
        decodeKiroSettings({ enabled: true, binaryPath: "/definitely/not/installed/kiro-cli" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports ready with the CLI's models when logged in", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeKiroCli({
            whoami: { stdout: LOGGED_IN_WHOAMI },
            models: { stdout: LIST_MODELS_OUTPUT },
          });
          return yield* checkKiroProviderStatus(decodeKiroSettings({ enabled: true, binaryPath }));
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("2.23.1");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Kiro account",
        email: "dev@example.com",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "auto",
        "claude-sonnet-4.5",
        "claude-haiku-4.5",
      ]);
    }),
  );

  it.effect("reports unauthenticated from whoami without listing models", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeKiroCli({
            whoami: { stdout: "Not logged in\n", code: 1 },
            models: { stdout: "", stderr: "must not run", code: 9 },
          });
          return yield* checkKiroProviderStatus(decodeKiroSettings({ enabled: true, binaryPath }));
        }),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("kiro-cli login");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
    }),
  );

  it.effect("points at `kiro-cli setup` when the chat component cannot launch", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeKiroCli({
            whoami: { stdout: LOGGED_IN_WHOAMI },
            models: {
              stdout: "",
              stderr: "error: failed to launch /Users/dev/.local/bin/kiro-cli-chat\n",
              code: 1,
            },
          });
          return yield* checkKiroProviderStatus(decodeKiroSettings({ enabled: true, binaryPath }));
        }),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.message).toContain("kiro-cli setup");
    }),
  );

  it.effect("keeps chats available with a warning when the model listing fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeKiroCli({
            whoami: { stdout: LOGGED_IN_WHOAMI },
            models: { stdout: "", stderr: "network unreachable", code: 1 },
          });
          return yield* checkKiroProviderStatus(
            decodeKiroSettings({ enabled: true, binaryPath, customModels: ["my-model"] }),
          );
        }),
      );
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("listing models failed");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto", "my-model"]);
    }),
  );
});
