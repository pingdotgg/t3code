// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DevinSettings } from "@t3tools/contracts";

import {
  buildInitialDevinProviderSnapshot,
  checkDevinProviderStatus,
  parseDevinModelsListJson,
} from "./DevinProvider.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const SAMPLE_MODELS_LIST_JSON = JSON.stringify({
  families: [
    {
      family_label: "Claude Sonnet 4.6",
      family_uid: "claude-sonnet-4.6",
      slug: "claude-sonnet-4.6",
      aliases: ["sonnet"],
      variants: [
        {
          model_uid: "claude-sonnet-4-6",
          label: "Claude Sonnet 4.6",
          is_new: false,
          is_beta: false,
        },
        {
          model_uid: "claude-sonnet-4-6-thinking",
          label: "Claude Sonnet 4.6 Thinking",
          is_new: true,
          is_beta: false,
        },
      ],
    },
  ],
});

describe("parseDevinModelsListJson", () => {
  it("flattens family variants into provider models with aliases and new badges", () => {
    const models = parseDevinModelsListJson(SAMPLE_MODELS_LIST_JSON);
    expect(models).toHaveLength(2);
    expect(models.map((model) => [model.slug, model.name, model.badge, model.aliases])).toEqual([
      [
        "claude-sonnet-4-6",
        "Claude Sonnet 4.6",
        undefined,
        ["sonnet", "claude-sonnet-4.6", "claude-sonnet-4-6"],
      ],
      [
        "claude-sonnet-4-6-thinking",
        "Claude Sonnet 4.6 Thinking",
        "new",
        ["sonnet", "claude-sonnet-4.6", "claude-sonnet-4-6-thinking"],
      ],
    ]);
  });

  it("returns an empty array for invalid JSON", () => {
    expect(parseDevinModelsListJson("not json")).toEqual([]);
  });

  it("returns an empty array for unexpected shapes", () => {
    expect(parseDevinModelsListJson(JSON.stringify({ families: "nope" }))).toEqual([]);
  });
});

describe("buildInitialDevinProviderSnapshot", () => {
  it.effect("returns a disabled snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(decodeDevinSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );
});

it.layer(NodeServices.layer)("checkDevinProviderStatus", (it) => {
  const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

  const writeFakeDevinCli = (input: {
    readonly modelsOutput: string;
    readonly acpWorks: boolean;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-probe-" });
      const modelsPath = path.join(dir, "models.json");
      yield* fs.writeFileString(modelsPath, input.modelsOutput);
      const devinPath = path.join(dir, "devin");
      const mockAgentPath = NodePath.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");
      yield* fs.writeFileString(
        devinPath,
        [
          "#!/bin/sh",
          'case "$1" in',
          '  --version) printf "devin 3000.6.12\\n"; exit 0;;',
          `  models) shift; if [ "$1" = "list" ] && [ "$2" = "--format" ] && [ "$3" = "json" ]; then cat ${shellQuote(modelsPath)}; exit 0; fi; exit 1;;`,
          input.acpWorks
            ? `  acp) exec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)};;`
            : "  acp) exit 1;;",
          "esac",
          "exit 1",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(devinPath, 0o755);
      return devinPath;
    });

  it.effect(
    "reports ready with CLI-discovered models when ACP initialize does not advertise models",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* Effect.scoped(
          Effect.gen(function* () {
            const devinPath = yield* writeFakeDevinCli({
              modelsOutput: SAMPLE_MODELS_LIST_JSON,
              acpWorks: false,
            });
            return yield* checkDevinProviderStatus(
              decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
              process.env,
            );
          }),
        );

        expect(snapshot.status).toBe("ready");
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toBe("3000.6.12");
        expect(snapshot.auth).toEqual({ status: "authenticated" });
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "default",
          "claude-sonnet-4-6",
          "claude-sonnet-4-6-thinking",
        ]);
      }),
  );
});
