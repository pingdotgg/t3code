// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  DevinSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderAuth,
} from "@t3tools/contracts";

import {
  buildDevinModelsFromSession,
  checkDevinProviderStatus,
  healAdapterFlaggedAuth,
  makeDevinProvider,
  parseDevinAuthStatus,
  parseDevinModelsListJson,
} from "./DevinProvider.ts";
import { BackgroundPolicy } from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const LOGGED_IN_AUTH_OUTPUT = [
  "Logged in (via Devin).",
  "",
  "Credentials:",
  "  File:              /home/tester/.local/share/devin/credentials.toml",
  "",
  "User:",
  "  Name:              Test User",
  "  Email:             tester@example.com",
  "",
].join("\n");

const LOGGED_OUT_AUTH_OUTPUT = "Not logged in. Run `devin auth login`.\n";

const MODELS_JSON = JSON.stringify({
  families: [
    {
      slug: "swe-2",
      variants: [
        { model_uid: "swe-2-high", label: "SWE-2 High", is_new: true },
        { model_uid: "swe-2-medium", label: "SWE-2 Medium" },
        { model_uid: "swe-2-max", label: "SWE-2 Max" },
      ],
    },
    {
      slug: "claude",
      variants: [{ model_uid: "claude-opus-4.5", label: "Claude Opus 4.5" }],
    },
  ],
});

describe("parseDevinAuthStatus", () => {
  it("reads the logged-in verdict and account email", () => {
    expect(parseDevinAuthStatus(LOGGED_IN_AUTH_OUTPUT)).toEqual({
      authenticated: true,
      email: "tester@example.com",
    });
  });

  it("reads a logged-out verdict", () => {
    expect(parseDevinAuthStatus(LOGGED_OUT_AUTH_OUTPUT)).toEqual({
      authenticated: false,
      email: undefined,
    });
  });

  it("returns unknown for unrecognizable output", () => {
    expect(parseDevinAuthStatus("devin 3000.10.21\n")).toEqual({
      authenticated: null,
      email: undefined,
    });
  });
});

describe("parseDevinModelsListJson", () => {
  it("flattens families into a catalog and marks the flagship default", () => {
    const models = parseDevinModelsListJson(MODELS_JSON);
    expect(models.map((model) => model.slug)).toEqual([
      "swe-2-high",
      "swe-2-medium",
      "swe-2-max",
      "claude-opus-4.5",
    ]);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.badge).toBe("new");
    expect(models[1]?.isDefault).toBeUndefined();
  });

  it("dedupes variants and falls back to the slug for empty labels", () => {
    const models = parseDevinModelsListJson(
      JSON.stringify({
        families: [
          {
            variants: [
              { model_uid: "swe-2-high", label: "" },
              { model_uid: "swe-2-high", label: "dup" },
            ],
          },
        ],
      }),
    );
    expect(models.map((model) => model.slug)).toEqual(["swe-2-high"]);
    expect(models[0]?.name).toBe("swe-2-high");
  });

  it("marks the first model default when the flagship is absent", () => {
    const models = parseDevinModelsListJson(
      JSON.stringify({
        families: [{ variants: [{ model_uid: "claude-sonnet-4.5" }] }],
      }),
    );
    expect(models[0]?.isDefault).toBe(true);
  });

  it("returns no models for malformed or empty output", () => {
    expect(parseDevinModelsListJson("not json")).toEqual([]);
    expect(parseDevinModelsListJson("{}")).toEqual([]);
  });
});

describe("buildDevinModelsFromSession", () => {
  it("reads the catalog from the model config option and marks the current value", () => {
    const models = buildDevinModelsFromSession([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "swe-2-medium",
        options: [
          { value: "swe-2-high", name: "SWE-2 High" },
          { value: "swe-2-medium", name: "SWE-2 Medium" },
        ],
      },
    ]);
    expect(models.map((model) => model.slug)).toEqual(["swe-2-high", "swe-2-medium"]);
    expect(models[1]?.isDefault).toBe(true);
  });

  it("flattens grouped option entries", () => {
    const models = buildDevinModelsFromSession([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "swe-2-high",
        options: [
          {
            group: "SWE-2",
            name: "SWE-2",
            options: [
              { value: "swe-2-high", name: "SWE-2 High" },
              { value: "swe-2-max", name: "SWE-2 Max" },
            ],
          },
        ],
      },
    ]);
    expect(models.map((model) => model.slug)).toEqual(["swe-2-high", "swe-2-max"]);
  });

  it("returns no models when no model option exists", () => {
    expect(buildDevinModelsFromSession([])).toEqual([]);
    expect(
      buildDevinModelsFromSession([
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "smart",
          options: [{ value: "smart", name: "Smart" }],
        },
      ]),
    ).toEqual([]);
  });
});

// A stand-in for the Devin CLI: `version`, `auth status`, and
// `models list --format json` print canned text. `acp` exits non-zero so a
// probe that accidentally spawned it would fail loudly.
const writeFakeDevinCli = (input: {
  readonly authOutput: string;
  readonly modelsOutput?: string;
  readonly versionOutput?: string;
  /** Every invocation's argv lands here, so tests can prove `acp` never ran. */
  readonly argvLogPath?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-probe-" });
    return writeFakeCli({
      directory: dir,
      name: "devin",
      source: [
        ...(input.argvLogPath === undefined
          ? []
          : [
              'import { appendFileSync } from "node:fs";',
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `appendFileSync(${JSON.stringify(input.argvLogPath)}, process.argv.slice(2).join(" ") + "\\n");`,
            ]),
        "const sub = process.argv[2];",
        'if (sub === "version") {',
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `  process.stdout.write(${JSON.stringify(input.versionOutput ?? "devin 3000.10.21 (611c1cba)\n")});`,
        "  process.exit(0);",
        "}",
        'if (sub === "auth") {',
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `  process.stdout.write(${JSON.stringify(input.authOutput)});`,
        "  process.exit(0);",
        "}",
        'if (sub === "models") {',
        ...(input.modelsOutput === undefined
          ? ["  process.exit(3);"]
          : [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `  process.stdout.write(${JSON.stringify(input.modelsOutput)});`,
              "  process.exit(0);",
            ]),
        "}",
        'if (sub === "acp") process.exit(23);',
        "process.exit(1);",
        "",
      ].join("\n"),
    });
  });

it.layer(NodeServices.layer)("checkDevinProviderStatus", (it) => {
  it.effect("reports ready with account auth and the CLI model catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const probeDir = yield* fs.makeTempDirectory({ prefix: "t3code-devin-argv-" });
      const argvLogPath = NodePath.join(probeDir, "argv.log");
      const probe = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_IN_AUTH_OUTPUT,
            modelsOutput: MODELS_JSON,
            argvLogPath,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            { ...process.env, WINDSURF_API_KEY: "" },
          );
        }),
      );

      expect(probe.installed).toBe(true);
      expect(probe.status).toBe("ready");
      expect(probe.version).toBe("3000.10.21");
      expect(probe.auth).toEqual({
        status: "authenticated",
        type: "devin_account",
        label: "Devin account",
        email: "tester@example.com",
      });
      expect(probe.models.map((model) => model.slug)).toContain("swe-2-high");

      const argvLog = yield* fs.readFileString(argvLogPath);
      expect(argvLog).toContain("version");
      expect(argvLog).toContain("auth status");
      expect(argvLog).toContain("models list --format json");
      // The health probe is CLI-only by design — it must never spawn the ACP
      // server, which could trigger an interactive login.
      expect(argvLog).not.toContain("acp");
    }),
  );

  it.effect("reports unauthenticated when the CLI is logged out", () =>
    Effect.gen(function* () {
      const probe = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({ authOutput: LOGGED_OUT_AUTH_OUTPUT });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            { ...process.env, WINDSURF_API_KEY: "" },
          );
        }),
      );

      expect(probe.status).toBe("error");
      expect(probe.auth.status).toBe("unauthenticated");
      expect(probe.message).toContain("devin auth login");
      expect(probe.models).toEqual([]);
    }),
  );

  it.effect("reports not installed when the binary is missing", () =>
    Effect.gen(function* () {
      const probe = yield* checkDevinProviderStatus(
        decodeDevinSettings({ enabled: true, binaryPath: "/nonexistent/devin-binary" }),
        { ...process.env, WINDSURF_API_KEY: "" },
      );

      expect(probe.installed).toBe(false);
      expect(probe.status).toBe("error");
      expect(probe.message).toContain("not installed");
    }),
  );

  it.effect("marks API-key environments authenticated without trusting auth status", () =>
    Effect.gen(function* () {
      const probe = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_OUT_AUTH_OUTPUT,
            modelsOutput: MODELS_JSON,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            { ...process.env, WINDSURF_API_KEY: "ws-key" },
          );
        }),
      );

      expect(probe.auth).toEqual({
        status: "authenticated",
        type: "api_key",
        label: "Devin API key",
      });
      expect(probe.status).toBe("ready");
    }),
  );

  it.effect("degrades to a warning when the auth verdict is unparseable", () =>
    Effect.gen(function* () {
      const probe = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: "unexpected output\n",
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
            { ...process.env, WINDSURF_API_KEY: "" },
          );
        }),
      );

      expect(probe.auth.status).toBe("unknown");
      expect(probe.status).toBe("warning");
      expect(probe.models).toEqual([]);
    }),
  );
});

const DEVIN_TEST_INSTANCE = ProviderInstanceId.make("devin");

const MODEL_CONFIG_OPTION = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "swe-2-high",
  options: [
    { value: "swe-2-high", name: "SWE-2 High" },
    { value: "swe-2-medium", name: "SWE-2 Medium" },
  ],
} as const;

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
    ServerSettingsService.layerTest(),
  ),
)("DevinProvider auth healing", (it) => {
  it.effect("heals an adapter-set sign-out flag on session events but never a probe-set one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let probeAuth: ServerProviderAuth = { status: "authenticated" };
        const provider = yield* makeDevinProvider(decodeDevinSettings({ enabled: true }), {
          stampIdentity: (draft) => ({
            ...draft,
            instanceId: DEVIN_TEST_INSTANCE,
            driver: ProviderDriverKind.make("devin"),
          }),
          probe: Effect.suspend(() =>
            Effect.succeed({
              installed: true,
              version: "3000.10.21",
              auth: probeAuth,
              status:
                probeAuth.status === "authenticated" ? ("ready" as const) : ("error" as const),
              message: undefined,
              modelsFetched: false,
              models: [],
            }),
          ),
          resolveMaintenance: () =>
            Effect.succeed({
              provider: ProviderDriverKind.make("devin"),
              packageName: null,
              update: null,
            }),
        });

        // A session-start error match flags auth; a live session event heals it.
        yield* provider.onAuthRequired;
        let snapshot = yield* provider.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.supportsTextGeneration).toBe(false);

        yield* provider.onConfigOptionsUpdated?.([MODEL_CONFIG_OPTION]);
        snapshot = yield* provider.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.status).toBe("ready");
        expect(snapshot.supportsTextGeneration).toBe(true);
        expect(snapshot.models.map((model) => model.slug)).toEqual(["swe-2-high", "swe-2-medium"]);

        // The probe's sign-out verdict is authoritative: live session events
        // must not undo it.
        probeAuth = { status: "unauthenticated" };
        yield* provider.snapshot.refresh;
        snapshot = yield* provider.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");

        yield* provider.onConfigOptionsUpdated?.([MODEL_CONFIG_OPTION]);
        snapshot = yield* provider.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");
      }),
    ),
  );
});

describe("healAdapterFlaggedAuth", () => {
  it("restores a signed-in presentation for an unauthenticated draft", () => {
    const healed = healAdapterFlaggedAuth({
      auth: { status: "unauthenticated" },
      status: "warning",
      message: "Devin is not signed in. Run `devin auth login`, then start the thread again.",
      supportsTextGeneration: false,
    } as never);
    expect(healed).toEqual({
      auth: { status: "authenticated" },
      status: "ready",
      message: undefined,
      supportsTextGeneration: true,
    });
  });

  it("leaves non-unauthenticated drafts untouched", () => {
    expect(healAdapterFlaggedAuth({ auth: { status: "authenticated" } } as never)).toEqual({});
    expect(healAdapterFlaggedAuth({ auth: { status: "unknown" } } as never)).toEqual({});
  });
});
