import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { PiAgentSettings } from "@t3tools/contracts";

import {
  buildInitialPiAgentProviderSnapshot,
  checkPiAgentProviderStatus,
  piDiscoveredModelsFromAvailableModels,
} from "./PiAgentProvider.ts";

const decodePiAgentSettings = Schema.decodeSync(PiAgentSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/pi-mock-agent.ts");

/** Writes a fake `pi` CLI that answers --version itself and defers everything
 * else to the pi mock agent (which speaks the JSONL RPC protocol). */
const writeMockPiWrapper = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-rpc-models-" });
  const wrapperPath = path.join(dir, "pi");
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf "pi-cli 0.9.7\\n"
  exit 0
fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  yield* fs.writeFileString(wrapperPath, script);
  yield* fs.chmod(wrapperPath, 0o755);
  return wrapperPath;
});

describe("buildInitialPiAgentProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiAgentProviderSnapshot(
        decodePiAgentSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiAgentProviderSnapshot(decodePiAgentSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Pi");
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-haiku-4-5",
        "openai/gpt-5",
      ]);
    }),
  );
});

describe("piDiscoveredModelsFromAvailableModels", () => {
  it("maps RPC entries to provider/id slugs and dedupes", () => {
    const models = piDiscoveredModelsFromAvailableModels([
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        provider: "anthropic",
        api: "anthropic",
      },
      { id: "claude-sonnet-4-6", name: undefined, provider: "anthropic", api: undefined },
      { id: "gpt-5", name: "GPT-5", provider: "openai", api: "openai" },
      { id: "local-model", name: undefined, provider: undefined, api: undefined },
    ]);
    expect(models.map((model) => model.slug)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5",
      "local-model",
    ]);
    expect(models[0]?.isCustom).toBe(false);
    expect(models[0]?.name).toBe("Claude Sonnet 4.6");
    expect(models[2]?.name).toBe("local-model");
  });

  it("filters out empty ids", () => {
    const models = piDiscoveredModelsFromAvailableModels([
      { id: "  ", name: undefined, provider: "anthropic", api: undefined },
      { id: "gpt-5", name: undefined, provider: "openai", api: undefined },
    ]);
    expect(models.map((model) => model.slug)).toEqual(["openai/gpt-5"]);
  });
});

it.layer(NodeServices.layer)("checkPiAgentProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiAgentProviderStatus(
        decodePiAgentSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/pi-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("falls back to the static catalog when the RPC model probe fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-success-" });
          const piPath = path.join(dir, "pi");
          yield* fs.writeFileString(
            piPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then',
              '  printf "pi-cli 0.9.7\\n"',
              "  exit 0",
              "fi",
              "exit 1",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(piPath, 0o755);

          return yield* checkPiAgentProviderStatus(
            decodePiAgentSettings({ enabled: true, binaryPath: piPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.9.7");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-haiku-4-5",
        "openai/gpt-5",
      ]);
    }),
  );

  it.effect("uses discovered models from the RPC get_available_models probe", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeMockPiWrapper;
          return yield* checkPiAgentProviderStatus(
            decodePiAgentSettings({ enabled: true, binaryPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.9.7");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-haiku-4-5",
        "openai/gpt-5",
      ]);
      expect(snapshot.models[0]?.name).toBe("Claude Sonnet 4.6");
      expect(snapshot.models.every((model) => !model.isCustom)).toBe(true);
    }),
  );

  it.effect("appends custom models on top of the discovered catalog", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeMockPiWrapper;
          return yield* checkPiAgentProviderStatus(
            decodePiAgentSettings({
              enabled: true,
              binaryPath,
              customModels: ["my-custom-model"],
            }),
          );
        }),
      );

      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-haiku-4-5",
        "openai/gpt-5",
        "my-custom-model",
      ]);
      expect(snapshot.models[3]?.isCustom).toBe(true);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-version-" });
          const piPath = path.join(dir, "pi");
          yield* fs.writeFileString(
            piPath,
            ["#!/bin/sh", 'printf "%s\\n" "broken pi install" >&2', "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(piPath, 0o755);

          return yield* checkPiAgentProviderStatus(
            decodePiAgentSettings({ enabled: true, binaryPath: piPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Pi CLI is installed but failed to run.");
    }),
  );
});
