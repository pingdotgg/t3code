import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { OmpSettings } from "@t3tools/contracts";

import {
  buildOmpModelsFromJson,
  checkOmpProviderStatus,
  ompModelsCommandArgs,
  parseOmpModelsJson,
} from "./OmpProvider.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

describe("OMP model catalog", () => {
  it("builds per-model capabilities and provider labels from model JSON", () => {
    expect(
      buildOmpModelsFromJson(
        {
          models: [
            {
              provider: "moonshot",
              id: "kimi-k2.6",
              selector: "moonshot/kimi-k2.6",
              name: "Kimi K2.6",
              thinking: ["low", "high"],
              input: ["text", "image"],
            },
            {
              provider: "openrouter",
              id: "moonshotai/kimi-k2.6",
              selector: "openrouter/moonshotai/kimi-k2.6",
              name: "Kimi K2.6",
              thinking: null,
              input: ["text"],
            },
            { provider: "openai", selector: "openai/missing-name" },
            {
              provider: "moonshot",
              selector: "moonshot/kimi-k2.6",
              name: "Duplicate",
              thinking: [],
            },
          ],
        },
        { defaultModelRole: "moonshot/kimi-k2.6:high", defaultThinking: "low" },
      ),
    ).toEqual([
      {
        slug: "moonshot/kimi-k2.6",
        name: "Kimi K2.6",
        subProvider: "Moonshot",
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking",
              label: "Thinking",
              type: "select",
              currentValue: "high",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
              ],
            },
          ],
        },
      },
      {
        slug: "openrouter/moonshotai/kimi-k2.6",
        name: "Kimi K2.6",
        subProvider: "OpenRouter",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("rejects malformed JSON and only preserves configured model catalog arguments", () => {
    expect(parseOmpModelsJson("not json")).toBeUndefined();
    expect(parseOmpModelsJson('{"unexpected":[]}')).toEqual([]);
    expect(
      ompModelsCommandArgs('--config first.yml --extension unsafe.ts --config="second config.yml"'),
    ).toEqual([
      "models",
      "--json",
      "--no-extensions",
      "--config",
      "first.yml",
      "--config",
      "second config.yml",
    ]);
  });
});

it.layer(NodeServices.layer)("checkOmpProviderStatus", (it) => {
  const makeOmpScript = (lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-omp-status-" });
      const binaryPath = path.join(dir, "omp");
      yield* fs.writeFileString(binaryPath, ["#!/bin/sh", ...lines, ""].join("\n"));
      yield* fs.chmod(binaryPath, 0o755);
      return binaryPath;
    });

  it.effect("reports disabled settings without starting a process", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOmpProviderStatus(decodeOmpSettings({ enabled: false }));
      expect(snapshot).toMatchObject({
        enabled: false,
        installed: false,
        status: "disabled",
      });
    }),
  );

  it.effect("reports a missing configured binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({ enabled: true, binaryPath: "/definitely/not/installed/omp" }),
      );
      expect(snapshot).toMatchObject({ installed: false, status: "error" });
      expect(snapshot.message).toContain("not installed");
    }),
  );

  it.effect("rejects an invalid or old version before model discovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const invalidBinaryPath = yield* makeOmpScript(['printf "not a version\\n"']);
        const invalid = yield* checkOmpProviderStatus(
          decodeOmpSettings({ enabled: true, binaryPath: invalidBinaryPath }),
        );
        expect(invalid.message).toContain("valid version");

        const oldBinaryPath = yield* makeOmpScript([
          'if [ "$1" = "--version" ]; then printf "omp/17.3.9\\n"; fi',
        ]);
        const old = yield* checkOmpProviderStatus(
          decodeOmpSettings({ enabled: true, binaryPath: oldBinaryPath }),
        );
        expect(old.message).toContain("too old");
      }),
    ),
  );

  it.effect("reports a failed or empty catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failedBinaryPath = yield* makeOmpScript([
          'if [ "$1" = "--version" ]; then printf "omp/17.4.0\\n"; exit 0; fi',
          'printf "catalog failed\\n" >&2',
          "exit 2",
        ]);
        const failed = yield* checkOmpProviderStatus(
          decodeOmpSettings({ enabled: true, binaryPath: failedBinaryPath }),
        );
        expect(failed.message).toContain("Failed to list Oh My Pi models");

        const invalidCatalogBinaryPath = yield* makeOmpScript([
          'if [ "$1" = "--version" ]; then printf "omp/17.4.0\\n"; exit 0; fi',
          'printf "not json\\n"',
        ]);
        const invalidCatalog = yield* checkOmpProviderStatus(
          decodeOmpSettings({ enabled: true, binaryPath: invalidCatalogBinaryPath }),
        );
        expect(invalidCatalog.message).toContain("invalid model data");

        const emptyBinaryPath = yield* makeOmpScript([
          'if [ "$1" = "--version" ]; then printf "omp/17.4.0\\n"; exit 0; fi',
          "printf '{\"models\":[]}\\n'",
        ]);
        const empty = yield* checkOmpProviderStatus(
          decodeOmpSettings({ enabled: true, binaryPath: emptyBinaryPath }),
        );
        expect(empty.message).toContain("returned no models");
      }),
    ),
  );

  it.effect(
    "preserves config overlays for model discovery without reading other config defaults",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const callsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-omp-calls-" });
          const callsPath = path.join(callsDir, "calls.log");
          const binaryPath = yield* makeOmpScript([
            'printf "%s\\n" "$*" >> "$OMP_CALLS"',
            'if [ "$1" = "--version" ]; then printf "omp/17.4.0\\n"; exit 0; fi',
            'if [ "$1" = "models" ] && [ "$2" = "--json" ] && [ "$3" = "--no-extensions" ] && [ "$OMP_PROFILE" = "work profile" ]; then',
            '  printf \'%s\\n\' \'{"models":[{"provider":"openai","id":"gpt-5.4","selector":"openai/gpt-5.4","name":"GPT-5.4","thinking":["low","high"],"input":["text","image"]}]}\'',
            "  exit 0",
            "fi",
            "exit 2",
          ]);
          const snapshot = yield* checkOmpProviderStatus(
            decodeOmpSettings({
              enabled: true,
              binaryPath,
              launchArgs:
                '--extension unsafe.ts --config selected.yml --config="fallback config.yml" --profile "work profile"',
              customModels: ["extension/acme-model"],
            }),
            { ...process.env, OMP_CALLS: callsPath },
          );
          const calls = (yield* fs.readFileString(callsPath)).trim().split("\n").sort();
          expect(calls).toEqual(
            [
              "--version",
              "models --json --no-extensions --config selected.yml --config fallback config.yml",
            ].sort(),
          );
          expect(snapshot).toMatchObject({ installed: true, status: "ready", slashCommands: [] });
          expect(snapshot.models).toMatchObject([
            {
              slug: "default",
              name: "OMP config default",
              isDefault: true,
            },
            {
              slug: "openai/gpt-5.4",
              subProvider: "OpenAI",
              capabilities: {
                optionDescriptors: [
                  {
                    id: "thinking",
                    options: [
                      { id: "low", label: "Low" },
                      { id: "high", label: "High" },
                    ],
                  },
                ],
              },
            },
            {
              slug: "extension/acme-model",
              name: "extension/acme-model",
              isCustom: true,
            },
          ]);
        }),
      ),
  );
});
