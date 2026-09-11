import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { JcodeSettings } from "@t3tools/contracts";

import {
  buildInitialJcodeProviderSnapshot,
  checkJcodeProviderStatus,
  jcodeModelsFromSettings,
  parseJcodeAuthStatus,
  parseJcodeModelList,
} from "./JcodeProvider.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeJcodeSettings = Schema.decodeSync(JcodeSettings); // @effect-diagnostics preferSchemaOverJson:off

const runSnapshot = (binaryPath: string) =>
  Effect.gen(function* () {
    return yield* checkJcodeProviderStatus(
      decodeJcodeSettings({ enabled: true, binaryPath }),
      process.env,
    );
  }).pipe(Effect.scoped);

describe("parseJcodeAuthStatus", () => {
  it("reads any_available from probe JSON", () => {
    expect(parseJcodeAuthStatus('{"any_available": true}').anyAvailable).toBe(true);
    expect(parseJcodeAuthStatus('{"any_available": false}').anyAvailable).toBe(false);
  });

  it("returns unknown for malformed or unrecognized output", () => {
    expect(parseJcodeAuthStatus("not json").anyAvailable).toBeNull();
    expect(parseJcodeAuthStatus('{"any_available": "yes"}').anyAvailable).toBeNull();
    expect(parseJcodeAuthStatus("{}").anyAvailable).toBeNull();
  });
});

describe("jcodeModelsFromSettings", () => {
  it("exposes the built-in auto model when no custom models are set", () => {
    expect(jcodeModelsFromSettings([]).map((model) => model.slug)).toEqual(["jcode-auto"]);
  });
});

const MODEL_LIST_JSON = JSON.stringify({
  provider: "OpenCode Go",
  selected_model: "kimi-k3",
  models: ["kimi-k3", "glm-5.3", "jcode-auto"],
  routes: [
    { provider: "OpenAI", model: "gpt-5.6", method: "chatgpt-web", available: false },
    { provider: "OpenCode Go", model: "kimi-k3", method: "api key", available: true },
    { provider: "OpenCode Go", model: "glm-5.3", method: "api key", available: true },
  ],
});

describe("parseJcodeModelList", () => {
  it("reads provider, selected model, and available routes", () => {
    const parsed = parseJcodeModelList(MODEL_LIST_JSON);
    expect(parsed.provider).toBe("OpenCode Go");
    expect(parsed.selectedModel).toBe("kimi-k3");
    expect(parsed.models).toEqual(["kimi-k3", "glm-5.3", "jcode-auto"]);
    expect(parsed.availableRoutes.map((route) => route.model)).toEqual(["kimi-k3", "glm-5.3"]);
  });

  it("returns an empty listing for malformed output", () => {
    expect(parseJcodeModelList("not json")).toEqual({
      provider: null,
      selectedModel: null,
      models: [],
      availableRoutes: [],
    });
  });
});

describe("buildInitialJcodeProviderSnapshot", () => {
  it.effect("shows a disabled warning before the first probe", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialJcodeProviderSnapshot(
        decodeJcodeSettings({ enabled: false }),
      );
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("shows a checking placeholder while installed state is unknown", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialJcodeProviderSnapshot(
        decodeJcodeSettings({ enabled: true }),
      );
      expect(snapshot.status).toBe("warning");
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.message).toContain("Checking");
    }),
  );
});

it.layer(NodeServices.layer)("checkJcodeProviderStatus", (it) => {
  const writeFakeJcodeCli = (input: {
    readonly versionOutput?: string;
    readonly versionExitCode?: number;
    readonly authOutput: string;
    readonly authExitCode?: number;
    readonly modelsOutput?: string;
    readonly modelsExitCode?: number;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-jcode-probe-" });
      return writeFakeCli({
        directory: dir,
        name: "jcode",
        source: [
          'if (process.argv[2] === "version") {',
          input.versionOutput === undefined
            ? '  process.stdout.write("jcode 0.84.0\\n");'
            : // The stringify is generating fake-CLI script source, not serializing data.
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `  process.stdout.write(${JSON.stringify(input.versionOutput)});`,

          `  process.exit(${input.versionExitCode ?? 0});`,
          "}",
          'if (process.argv[2] === "auth") {',
          // The stringify is generating fake-CLI script source, not serializing data.
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `  process.stdout.write(${JSON.stringify(input.authOutput)});`,
          `  process.exit(${input.authExitCode ?? 0});`,
          "}",
          'if (process.argv[2] === "model") {',
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `  process.stdout.write(${JSON.stringify(input.modelsOutput ?? "{}")});`,
          `  process.exit(${input.modelsExitCode ?? 0});`,
          "}",
          "process.exit(1);",
          "",
        ].join("\n"),
      });
    });

  it.effect("reports ready and authenticated when any_available is true", () =>
    Effect.gen(function* () {
      const jcodePath = yield* writeFakeJcodeCli({
        authOutput: '{"any_available": true}',
      });
      const snapshot = yield* runSnapshot(jcodePath);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.84.0");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Jcode account",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual(["jcode-auto"]);
    }),
  );

  it.effect("discovers models from `jcode model list --json` with auto first", () =>
    Effect.gen(function* () {
      const jcodePath = yield* writeFakeJcodeCli({
        authOutput: '{"any_available": true}',
        modelsOutput: MODEL_LIST_JSON,
      });
      const snapshot = yield* runSnapshot(jcodePath);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "jcode-auto",
        "kimi-k3",
        "glm-5.3",
      ]);
      // Selected model keeps its route metadata in the label for the picker.
      expect(snapshot.models[1]?.name).toBe("kimi-k3 (OpenCode Go · api key)");
    }),
  );

  it.effect("keeps the fallback model set when the model listing fails", () =>
    Effect.gen(function* () {
      const jcodePath = yield* writeFakeJcodeCli({
        authOutput: '{"any_available": true}',
        modelsExitCode: 1,
      });
      const snapshot = yield* runSnapshot(jcodePath);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["jcode-auto"]);
    }),
  );

  it.effect("reports unauthenticated when no credential is available", () =>
    Effect.gen(function* () {
      const jcodePath = yield* writeFakeJcodeCli({
        authOutput: '{"any_available": false}',
      });
      const snapshot = yield* runSnapshot(jcodePath);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("unauthenticated");
    }),
  );

  it.effect("reports unknown auth when the auth probe fails", () =>
    Effect.gen(function* () {
      const jcodePath = yield* writeFakeJcodeCli({
        authOutput: "{}",
      });
      const snapshot = yield* runSnapshot(jcodePath);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("unknown");
    }),
  );

  it.effect("flags a missing binary when the CLI cannot be spawned", () =>
    Effect.gen(function* () {
      const snapshot = yield* runSnapshot("/nonexistent/jcode-binary");
      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("not installed");
      expect(snapshot.auth.status).toBe("unknown");
    }),
  );

  it.effect("errors when the version probe exits non-zero", () =>
    Effect.gen(function* () {
      const jcodePath = yield* writeFakeJcodeCli({
        versionExitCode: 3,
        authOutput: '{"any_available": true}',
      });
      const snapshot = yield* runSnapshot(jcodePath);
      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.message).toContain("failed to run");
    }),
  );
});
