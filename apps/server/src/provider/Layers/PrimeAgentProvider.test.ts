import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { PrimeAgentSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildInitialPrimeAgentProviderSnapshot,
  checkPrimeAgentProviderStatus,
  parsePrimeAgentModelList,
  parsePrimeAgentModelListRows,
} from "./PrimeAgentProvider.ts";

const decodePrimeAgentSettings = Schema.decodeSync(PrimeAgentSettings);

describe("parsePrimeAgentModelList", () => {
  it("parses provider-qualified models and thinking capabilities", () => {
    const models = parsePrimeAgentModelList(
      [
        "provider model context max-out thinking images",
        "openai gpt-5.4 400k 128k yes yes",
        "anthropic claude-sonnet-4-6 200k 64k no yes",
        "warning emitted by unrelated startup hook",
      ].join("\n"),
    );

    expect(models.map((model) => model.slug)).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(models[0]).toMatchObject({
      name: "gpt-5.4",
      subProvider: "openai",
      isCustom: false,
    });
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        options: [
          { id: "off", label: "Off" },
          { id: "minimal", label: "Minimal" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max" },
        ],
      },
    ]);
    expect(models[1]?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("accepts ANSI output, table borders, a split max out heading, and deduplicates rows", () => {
    const output = [
      "\u001b[1m│ Provider │ Model │ Context │ Max Out │ Thinking │ Images │\u001b[0m",
      "├──────────┼─────────┼─────────┼─────────┼──────────┼────────┤",
      "│ openai │ gpt-5.4 │ 400k │ 128k │ YES │ yes │",
      "│ openai │ gpt-5.4 │ 400k │ 128k │ yes │ yes │",
    ].join("\n");

    expect(parsePrimeAgentModelListRows(output)).toEqual([
      {
        provider: "openai",
        model: "gpt-5.4",
        context: "400k",
        maxOut: "128k",
        thinking: "YES",
        images: "yes",
      },
      {
        provider: "openai",
        model: "gpt-5.4",
        context: "400k",
        maxOut: "128k",
        thinking: "yes",
        images: "yes",
      },
    ]);
    expect(parsePrimeAgentModelList(output)).toHaveLength(1);
  });
});

describe("buildInitialPrimeAgentProviderSnapshot", () => {
  it.effect("returns a disabled snapshot with the default model", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPrimeAgentProviderSnapshot(
        decodePrimeAgentSettings({ enabled: false }),
      );

      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
      expect(snapshot.models).toMatchObject([
        { slug: "default", name: "Prime Agent Default", isDefault: true },
      ]);
    }),
  );

  it.effect("returns an early-access pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPrimeAgentProviderSnapshot(
        decodePrimeAgentSettings({ enabled: true }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.badgeLabel).toBe("Early Access");
      expect(snapshot.showInteractionModeToggle).toBe(false);
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
      expect(snapshot.models[0]).toMatchObject({
        slug: "default",
        name: "Prime Agent Default",
        isDefault: true,
      });
    }),
  );
});

it.layer(NodeServices.layer)("checkPrimeAgentProviderStatus", (it) => {
  it.effect("reports a missing binary while retaining the default model", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPrimeAgentProviderStatus(
        decodePrimeAgentSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/prime-agent",
        }),
      );

      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("/definitely/not/installed/prime-agent");
      expect(snapshot.message).toMatch(/not found|invalid/);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    }),
  );

  it.effect("discovers stderr models after the built-in default and merges custom models", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-prime-agent-success-",
          });
          const binaryPath = path.join(dir, "prime-agent");
          yield* fileSystem.writeFileString(
            binaryPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then',
              '  printf "prime-agent 1.2.3\\n"',
              "  exit 0",
              "fi",
              'if [ "$1" = "model" ] && [ "$2" = "list" ]; then',
              '  [ "$PI_OFFLINE" = "1" ] || exit 3',
              '  printf "provider model context max-out thinking images\\n" >&2',
              '  printf "openai gpt-5.4 400k 128k yes yes\\n" >&2',
              '  printf "anthropic claude-sonnet-4-6 200k 64k no yes\\n" >&2',
              "  exit 0",
              "fi",
              "exit 2",
              "",
            ].join("\n"),
          );
          yield* fileSystem.chmod(binaryPath, 0o755);

          return yield* checkPrimeAgentProviderStatus(
            decodePrimeAgentSettings({
              enabled: true,
              binaryPath,
              customModels: ["custom/local-model", "openai/gpt-5.4"],
            }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("1.2.3");
      expect(snapshot.auth).toEqual({ status: "unknown" });
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "default",
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
        "custom/local-model",
      ]);
      expect(snapshot.models[0]).toMatchObject({
        name: "Prime Agent Default",
        isDefault: true,
        capabilities: { optionDescriptors: [] },
      });
    }),
  );

  it.effect("does not expose model-list stderr when discovery exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "prime-agent-secret-token";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-prime-agent-failure-",
          });
          const binaryPath = path.join(dir, "prime-agent");
          yield* fileSystem.writeFileString(
            binaryPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then',
              '  printf "prime-agent 1.2.3\\n"',
              "  exit 0",
              "fi",
              `printf "%s\\n" "${secretStderr}" >&2`,
              "exit 2",
              "",
            ].join("\n"),
          );
          yield* fileSystem.chmod(binaryPath, 0o755);

          return yield* checkPrimeAgentProviderStatus(
            decodePrimeAgentSettings({ enabled: true, binaryPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.message).toBe("Prime Agent CLI is installed but model discovery failed.");
      expect(snapshot.message).not.toContain(secretStderr);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    }),
  );
});
