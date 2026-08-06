import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { OpenClawSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { OpenClawRuntimeLive } from "../openclawRuntime.ts";
import { startMockOpenClawGateway } from "../testUtils/openclawMockGateway.ts";
import {
  checkOpenClawProviderStatus,
  makePendingOpenClawProvider,
  openClawDiscoveredModelsFromCatalog,
  parseOpenClawModelsList,
} from "./OpenClawProvider.ts";

const decodeOpenClawSettings = Schema.decodeSync(OpenClawSettings);

const openClawProviderTestLayer = NodeServices.layer.pipe(
  Layer.provideMerge(
    OpenClawRuntimeLive.pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, Layer.succeed(HostProcessPlatform, process.platform)),
      ),
    ),
  ),
);

/** Writes a fake `openclaw` CLI into the current scope's temp directory. */
const writeFakeOpenClawCli = (lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-openclaw-provider-" });
    const binaryPath = path.join(dir, "openclaw");
    yield* fs.writeFileString(binaryPath, lines.join("\n"));
    yield* fs.chmod(binaryPath, 0o755);
    return binaryPath;
  });

describe("makePendingOpenClawProvider", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingOpenClawProvider(
        decodeOpenClawSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("disabled");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-haiku-4-5",
      ]);
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingOpenClawProvider(decodeOpenClawSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking OpenClaw gateway availability");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-haiku-4-5",
      ]);
    }),
  );

  it.effect("appends custom models to the static catalog", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingOpenClawProvider(
        decodeOpenClawSettings({ customModels: ["my-custom-model"] }),
      );
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-haiku-4-5",
        "my-custom-model",
      ]);
      expect(snapshot.models[2]?.isCustom).toBe(true);
    }),
  );
});

describe("parseOpenClawModelsList", () => {
  it("parses a models array of objects and strings", () => {
    const entries = parseOpenClawModelsList({
      models: [{ id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" }, "openai/gpt-5"],
    });
    expect(entries).toEqual([
      { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "openai/gpt-5" },
    ]);
  });

  it("parses a catalog array", () => {
    const entries = parseOpenClawModelsList({
      catalog: [{ id: "anthropic/claude-haiku-4-5" }],
    });
    expect(entries).toEqual([{ id: "anthropic/claude-haiku-4-5" }]);
  });

  it("parses the verified CLI envelope (key entries) and drops unavailable models", () => {
    // Shape verified against `openclaw models list --json` (2026.7.1).
    const entries = parseOpenClawModelsList({
      count: 3,
      models: [
        {
          key: "openrouter/thinkingmachines/inkling-small",
          name: "thinkingmachines/inkling-small",
          available: true,
          missing: false,
          tags: ["default", "configured"],
        },
        {
          key: "deepseek/deepseek-v4-flash-0731",
          name: "deepseek/deepseek-v4-flash-0731",
          available: false,
          missing: false,
          tags: ["configured"],
        },
        {
          key: "openai/gpt-5.6-luna",
          name: "gpt-5.6-luna",
          available: true,
          missing: true,
          tags: ["configured"],
        },
      ],
    });
    expect(entries).toEqual([
      { id: "openrouter/thinkingmachines/inkling-small", name: "thinkingmachines/inkling-small" },
    ]);
  });

  it("parses default.models", () => {
    const entries = parseOpenClawModelsList({
      default: { models: [{ id: "gpt-5", name: "GPT-5" }] },
    });
    expect(entries).toEqual([{ id: "gpt-5", name: "GPT-5" }]);
  });

  it("skips entries without an id", () => {
    const entries = parseOpenClawModelsList({
      models: [{ id: "  " }, { name: "No id" }, { id: "gpt-5" }],
    });
    expect(entries).toEqual([{ id: "gpt-5" }]);
  });

  it("returns undefined when nothing parses", () => {
    expect(parseOpenClawModelsList(undefined)).toBeUndefined();
    expect(parseOpenClawModelsList("garbage")).toBeUndefined();
    expect(parseOpenClawModelsList({})).toBeUndefined();
    expect(parseOpenClawModelsList({ models: [] })).toBeUndefined();
    expect(parseOpenClawModelsList({ models: "not-an-array" })).toBeUndefined();
  });
});

describe("openClawDiscoveredModelsFromCatalog", () => {
  it("maps entries to ServerProviderModels and dedupes by slug", () => {
    const models = openClawDiscoveredModelsFromCatalog([
      { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "anthropic/claude-sonnet-4-6" },
      { id: "gpt-5" },
    ]);
    expect(models.map((model) => model.slug)).toEqual(["anthropic/claude-sonnet-4-6", "gpt-5"]);
    expect(models[0]?.isCustom).toBe(false);
    expect(models[1]?.name).toBe("gpt-5");
  });

  it("filters out empty slugs", () => {
    const models = openClawDiscoveredModelsFromCatalog([
      { id: "  " },
      { id: "gpt-5", name: "GPT-5" },
    ]);
    expect(models.map((model) => model.slug)).toEqual(["gpt-5"]);
  });
});

describe("OpenClaw reasoning capabilities", () => {
  it("advertises a reasoningEffort select descriptor on built-in models", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingOpenClawProvider(decodeOpenClawSettings({}));
      for (const model of snapshot.models) {
        const descriptors = model.capabilities?.optionDescriptors ?? [];
        const reasoning = descriptors.find((descriptor) => descriptor.id === "reasoningEffort");
        expect(reasoning).toBeDefined();
        expect(reasoning?.type).toBe("select");
        if (reasoning?.type === "select") {
          expect(reasoning.options.map((option) => option.id)).toEqual([
            "off",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
          ]);
          expect(reasoning.options.find((option) => option.isDefault)?.id).toBe("medium");
        }
      }
    }));

  it("advertises the reasoningEffort descriptor on discovered catalog models", () => {
    const models = openClawDiscoveredModelsFromCatalog([
      { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ]);
    const reasoning = models[0]?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "reasoningEffort",
    );
    expect(reasoning?.type).toBe("select");
  });
});

describe("checkOpenClawProviderStatus", () => {
  it.live("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOpenClawProviderStatus(
        decodeOpenClawSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toContain("disabled");
    }).pipe(Effect.provide(openClawProviderTestLayer)),
  );

  it.live("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOpenClawProviderStatus(
        decodeOpenClawSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/openclaw",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }).pipe(Effect.provide(openClawProviderTestLayer)),
  );

  it.live("reports ready with the CLI version and falls back when models list fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeOpenClawCli([
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then',
            '  printf "openclaw 1.2.3\\n"',
            "  exit 0",
            "fi",
            'if [ "$1" = "models" ]; then',
            '  printf "unexpected output format\\n" >&2',
            "  exit 1",
            "fi",
            "exit 1",
            "",
          ]);
          return yield* checkOpenClawProviderStatus(
            decodeOpenClawSettings({ enabled: true, binaryPath }),
          );
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("1.2.3");
      expect(snapshot.message).toBe("OpenClaw v1.2.3 is available.");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-haiku-4-5",
      ]);
    }).pipe(Effect.provide(openClawProviderTestLayer)),
  );

  it.live("uses discovered models when models list parses", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeOpenClawCli([
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then',
            '  printf "openclaw 1.2.3\\n"',
            "  exit 0",
            "fi",
            'if [ "$1" = "models" ]; then',
            '  printf \'{"models":[{"id":"anthropic/claude-sonnet-4-6","name":"Claude Sonnet 4.6"}]}\\n\'',
            "  exit 0",
            "fi",
            "exit 1",
            "",
          ]);
          return yield* checkOpenClawProviderStatus(
            decodeOpenClawSettings({ enabled: true, binaryPath }),
          );
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["anthropic/claude-sonnet-4-6"]);
    }).pipe(Effect.provide(openClawProviderTestLayer)),
  );

  it.live("appends custom models to the discovered or fallback catalog", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeOpenClawCli([
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then',
            '  printf "openclaw 1.2.3\\n"',
            "  exit 0",
            "fi",
            'if [ "$1" = "models" ]; then',
            '  printf "unexpected output format\\n" >&2',
            "  exit 1",
            "fi",
            "exit 1",
            "",
          ]);
          return yield* checkOpenClawProviderStatus(
            decodeOpenClawSettings({
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
        "my-custom-model",
      ]);
      expect(snapshot.models[2]?.isCustom).toBe(true);
    }).pipe(Effect.provide(openClawProviderTestLayer)),
  );

  it.live("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* writeFakeOpenClawCli([
            "#!/bin/sh",
            'printf "broken openclaw install\\n" >&2',
            "exit 2",
            "",
          ]);
          return yield* checkOpenClawProviderStatus(
            decodeOpenClawSettings({ enabled: true, binaryPath }),
          );
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Failed to execute the OpenClaw CLI health check.");
    }).pipe(Effect.provide(openClawProviderTestLayer)),
  );

  it.live("connects to a configured external gateway and reports ready", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => startMockOpenClawGateway());
      const snapshot = yield* checkOpenClawProviderStatus(
        decodeOpenClawSettings({ enabled: true, gatewayUrl: mock.url }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("2026.8.1");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.message).toBe("Connected to the OpenClaw gateway (v2026.8.1).");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-haiku-4-5",
      ]);
      yield* Effect.promise(() => mock.close());
    }).pipe(Effect.provide(openClawProviderTestLayer)),
  );

  it.live("reports an error snapshot when the configured gateway is unreachable", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => startMockOpenClawGateway());
      const url = mock.url;
      yield* Effect.promise(() => mock.close());
      const snapshot = yield* checkOpenClawProviderStatus(
        decodeOpenClawSettings({ enabled: true, gatewayUrl: url }),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.message).toBe(
        "Couldn't reach the configured OpenClaw gateway. Check the Gateway URL and token.",
      );
    }).pipe(Effect.provide(openClawProviderTestLayer)),
  );
});
