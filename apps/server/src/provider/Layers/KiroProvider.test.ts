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

const LOGGED_IN_WHOAMI_OUTPUT = [
  '{"accountType":"IamIdentityCenter","email":"dev@example.com","region":"us-east-1","startUrl":"https://example.awsapps.com/start"}',
  "",
  "Profile:",
  "TestProfile",
  "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEFGHIJKL",
  "",
].join("\n");

const LOGGED_OUT_WHOAMI_OUTPUT = "Not logged in. Run `kiro-cli login` to sign in.\n";

const LIST_MODELS_OUTPUT = JSON.stringify({
  models: [
    {
      model_name: "auto",
      description: "Models chosen by task",
      model_id: "auto",
      context_window_tokens: 1000000,
      rate_multiplier: 1.0,
      rate_unit: "Credit",
    },
    {
      model_name: "claude-sonnet-5",
      description: "Claude Sonnet 5 model with 1M context window",
      model_id: "claude-sonnet-5",
      context_window_tokens: 1000000,
      rate_multiplier: 1.3,
      rate_unit: "Credit",
    },
    { model_name: "claude-sonnet-5", model_id: " claude-sonnet-5 " },
  ],
  default_model: "auto",
});

describe("parseKiroWhoamiOutput", () => {
  it("reads the JSON line ahead of the plain-text profile trailer", () => {
    expect(parseKiroWhoamiOutput(LOGGED_IN_WHOAMI_OUTPUT)).toEqual({
      authenticated: true,
      email: "dev@example.com",
      accountType: "IamIdentityCenter",
    });
  });

  it("recognizes a signed-out CLI", () => {
    expect(parseKiroWhoamiOutput(LOGGED_OUT_WHOAMI_OUTPUT).authenticated).toBe(false);
  });

  it("returns unknown auth for unrecognized output", () => {
    expect(parseKiroWhoamiOutput("kiro-cli 2.21.3\n").authenticated).toBeNull();
  });
});

describe("parseKiroModelsCliOutput", () => {
  it("maps the catalog, marks the default, and drops duplicate ids", () => {
    const models = parseKiroModelsCliOutput(LIST_MODELS_OUTPUT);
    expect(models.map((model) => [model.slug, model.name, model.isDefault ?? false])).toEqual([
      ["auto", "Auto", true],
      ["claude-sonnet-5", "claude-sonnet-5", false],
    ]);
  });

  it("returns no models for non-JSON output", () => {
    expect(parseKiroModelsCliOutput("Error: not logged in\n")).toEqual([]);
  });
});

describe("buildInitialKiroProviderSnapshot", () => {
  it.effect("returns a disabled snapshot by default because Kiro is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(decodeKiroSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
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
      expect(snapshot.supportsConversationRollback).toBe(false);
    }),
  );
});

it.layer(NodeServices.layer)("checkKiroProviderStatus", (it) => {
  // A stand-in for the Kiro CLI: `--version`, `whoami`, and `chat --list-models`
  // print canned text. No probe may reach `acp`.
  const writeFakeKiroCli = (input: {
    readonly whoamiOutput: string;
    readonly whoamiExitCode?: number;
    readonly modelsOutput?: string;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kiro-probe-" });
      return writeFakeCli({
        directory: dir,
        name: "kiro-cli",
        source: [
          'if (process.argv[2] === "--version") {',
          '  process.stdout.write("kiro-cli 2.21.3\\n");',
          "  process.exit(0);",
          "}",
          'if (process.argv[2] === "whoami") {',
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `  process.stdout.write(${JSON.stringify(input.whoamiOutput)});`,
          `  process.exit(${input.whoamiExitCode ?? 0});`,
          "}",
          'if (process.argv[2] === "chat" && process.argv.includes("--list-models")) {',
          ...(input.modelsOutput === undefined
            ? ["  process.exit(1);"]
            : [
                // @effect-diagnostics-next-line preferSchemaOverJson:off
                `  process.stdout.write(${JSON.stringify(`${input.modelsOutput}\n`)});`,
                "  process.exit(0);",
              ]),
          "}",
          "process.stderr.write(`unexpected args: ${process.argv.slice(2).join(' ')}\\n`);",
          "process.exit(7);",
          "",
        ].join("\n"),
      });
    });

  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKiroProviderStatus(
        decodeKiroSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/kiro-cli-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports ready with the account's models when logged in", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const kiroPath = yield* writeFakeKiroCli({
            whoamiOutput: LOGGED_IN_WHOAMI_OUTPUT,
            modelsOutput: LIST_MODELS_OUTPUT,
          });
          return yield* checkKiroProviderStatus(
            decodeKiroSettings({ enabled: true, binaryPath: kiroPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("2.21.3");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Kiro account",
        email: "dev@example.com",
      });
      expect(snapshot.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
        ["auto", true],
        ["claude-sonnet-5", false],
      ]);
      expect(snapshot.slashCommands.map((command) => command.name)).toContain("compact");
    }),
  );

  it.effect("reports unauthenticated from a signed-out `whoami` without listing models", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const kiroPath = yield* writeFakeKiroCli({
            whoamiOutput: LOGGED_OUT_WHOAMI_OUTPUT,
            whoamiExitCode: 1,
          });
          return yield* checkKiroProviderStatus(
            decodeKiroSettings({ enabled: true, binaryPath: kiroPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("kiro-cli login");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
    }),
  );

  it.effect("keeps the built-in model with a warning when the catalog cannot be read", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const kiroPath = yield* writeFakeKiroCli({ whoamiOutput: LOGGED_IN_WHOAMI_OUTPUT });
          return yield* checkKiroProviderStatus(
            decodeKiroSettings({ enabled: true, binaryPath: kiroPath, customModels: ["glm-5"] }),
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => [model.slug, model.isCustom])).toEqual([
        ["auto", false],
        ["glm-5", true],
      ]);
      expect(snapshot.message).toContain("model list could not be read");
    }),
  );
});
