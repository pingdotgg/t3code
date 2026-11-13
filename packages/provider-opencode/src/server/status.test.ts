import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import * as HttpClient from "effect/http/HttpClient";
import { OpenCodeSettings } from "../settings.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";
import {
  checkOpenCodeProviderStatus,
  loadOpenCode2Workspace,
  type OpenCode2Model,
  type OpenCode2Workspace,
} from "./status.ts";
import { probeOpenCodeRuntime } from "./versionProbe.ts";
import {
  OPENCODE_1_RESPONSES,
  OPENCODE_2_RESPONSES,
  replayOpenCodeServer,
} from "./probeResponses.fixture.ts";
import { DEFAULT_VERSION_STDOUT, OpenCodeRuntimeTestDouble, layerTest, makeOpenCodeSettings, runtimeMock } from "./status.part2.testkit.ts";

const checkProvider = Effect.fn("checkProvider")(function* (
  settings: OpenCodeSettings,
  cwd = process.cwd(),
  environment?: NodeJS.ProcessEnv,
  server = replayOpenCodeServer(OPENCODE_1_RESPONSES, settings.serverPassword),
  openCode2Models: Effect.Effect<
    ReadonlyArray<OpenCode2Model>,
    OpenCodeRuntime.OpenCodeRuntimeError
  > = Effect.succeed([]),
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const serverOwner = yield* OpenCodeServerOwner.make({
        binaryPath: settings.binaryPath,
        directory: cwd,
        ...(settings.serverPassword ? { serverPassword: settings.serverPassword } : {}),
        ...(environment ? { environment } : {}),
      });
      const probe = probeOpenCodeRuntime(settings, environment).pipe(
        Effect.provideService(HttpClient.HttpClient, server),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, OpenCodeRuntimeTestDouble),
      );
      return yield* checkOpenCodeProviderStatus(settings, cwd, probe, openCode2Models).pipe(
        Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
      );
    }),
  );
});

it.layer(layerTest)("checkOpenCodeProviderStatus", (it) => {
  it.effect.each(["version", "inventory", "models", "empty-v1", "empty-v2"] as const)(
    "records %s discovery failures in the existing trace and logger",
    (failure) =>
      Effect.gen(function* () {
        const cause = new Error("discovery connection reset");
        const v2 = failure === "models" || failure === "empty-v2";
        runtimeMock.state.versionStdout = v2 ? "opencode v2.0.18\n" : DEFAULT_VERSION_STDOUT;
        if (failure === "version") runtimeMock.state.runVersionError = cause;
        if (failure === "inventory") runtimeMock.state.inventoryError = cause;
        if (failure === "empty-v1") {
          runtimeMock.state.inventory = {
            providerList: {
              connected: ["openai"],
              all: [{ id: "openai", name: "OpenAI", models: {} }],
              default: {},
            },
            agents: [],
            skills: [],
          };
        }
        const spans: Array<Tracer.NativeSpan> = [];
        yield* checkProvider(
          makeOpenCodeSettings({ serverPassword: "private-password" }),
          process.cwd(),
          undefined,
          undefined,
          failure === "models"
            ? Effect.fail(
                new OpenCodeRuntime.OpenCodeRuntimeError({
                  operation: "model.list",
                  detail: "model list failed",
                  cause,
                }),
              )
            : Effect.succeed([]),
        ).pipe(
          Effect.provideService(
            Tracer.Tracer,
            Tracer.make({
              span: (options) => {
                const span = new Tracer.NativeSpan(options);
                spans.push(span);
                return span;
              },
            }),
          ),
          Effect.provide(Logger.layer([Logger.tracerLogger], { mergeWithExisting: false })),
        );

        const diagnostics = spans.flatMap((span) =>
          span.events
            .filter(([name]) => name === "OpenCode discovery failed")
            .map((event) => ({ span, event })),
        );
        NodeAssert.equal(diagnostics.length, 1);
        const {
          span,
          event: [, timestamp, attributes],
        } = diagnostics[0]!;
        NodeAssert.equal(attributes.provider, "opencode");
        NodeAssert.equal(
          attributes.phase,
          failure.startsWith("empty") ? (v2 ? "models" : "inventory") : failure,
        );
        NodeAssert.equal(attributes.outcome, failure.startsWith("empty") ? "empty" : "failed");
        NodeAssert.equal(attributes.serverMode, "managed");
        NodeAssert.equal(attributes["effect.logLevel"], "WARN");
        NodeAssert.ok(timestamp >= 0n);
        NodeAssert.ok(span.traceId.length > 0);
        NodeAssert.equal(span.attributes.get("discovery.outcome"), attributes.outcome);
        if (!failure.startsWith("empty")) {
          NodeAssert.match(String(attributes["effect.cause"]), /discovery connection reset/);
        }
        NodeAssert.ok(!JSON.stringify(attributes).includes("private-password"));
      }),
  );

  it.effect("keeps an empty legacy catalog retryable until connected providers list models", () =>
    Effect.gen(function* () {
      const upstream = { id: "openai", name: "OpenAI", models: {} };
      runtimeMock.state.inventory = {
        providerList: { connected: ["openai"], all: [upstream], default: {} },
        agents: [],
        skills: [],
      };
      const settings = makeOpenCodeSettings();
      const empty = yield* checkProvider(settings);
      NodeAssert.equal(empty.status, "warning");
      NodeAssert.equal(empty.auth.status, "unknown");
      NodeAssert.deepEqual(empty.models, []);

      upstream.models = {
        "gpt-5.4": { id: "gpt-5.4", name: "GPT-5.4", variants: {} },
      };
      const ready = yield* checkProvider(settings);
      NodeAssert.equal(ready.status, "ready");
      NodeAssert.equal(ready.auth.status, "authenticated");
      NodeAssert.deepEqual(
        ready.models.map((model) => model.slug),
        ["openai/gpt-5.4"],
      );
    }),
  );

  it.effect("emits OpenCode variant defaults so trait picker can resolve a visible selection", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["openai"],
          all: [
            {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  variants: {
                    none: {},
                    low: {},
                    medium: {},
                    high: {},
                    xhigh: {},
                  },
                },
              },
            },
          ],
          default: {},
        },
        agents: [
          { name: "build", hidden: false, mode: "primary" },
          { name: "plan", hidden: false, mode: "primary" },
        ],
      };

      const snapshot = yield* checkProvider(makeOpenCodeSettings());
      const model = snapshot.models.find((entry) => entry.slug === "openai/gpt-5.4");

      NodeAssert.ok(model);
      const variantDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "variant" && descriptor.type === "select",
      );
      NodeAssert.ok(variantDescriptor && variantDescriptor.type === "select");
      NodeAssert.equal(
        variantDescriptor.options.find((option) => option.isDefault === true)?.id,
        "medium",
      );
      const agentDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "agent" && descriptor.type === "select",
      );
      NodeAssert.ok(agentDescriptor && agentDescriptor.type === "select");
      NodeAssert.equal(
        agentDescriptor.options.find((option) => option.isDefault === true)?.id,
        "build",
      );
    }),
  );

  it.effect("includes OpenCode skills in the provider snapshot", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["openai"],
          all: [
            {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  variants: {},
                },
              },
            },
          ],
          default: {},
        },
        agents: [],
        skills: [
          {
            name: "openclaw-review",
            description: "Review OpenClaw workflow changes.",
            location: "/Users/test/.agents/skills/openclaw-review/SKILL.md",
          },
          {
            name: "openclaw-triage",
            description: "Triage OpenClaw routing issues.",
            location: "/Users/test/.agents/skills/openclaw-triage/SKILL.md",
          },
          {
            name: "missing-location",
            description: "This incomplete SDK row should be skipped.",
            location: "",
          },
        ],
      };

      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.deepEqual(
        snapshot.skills.map((skill) => ({
          name: skill.name,
          path: skill.path,
          enabled: skill.enabled,
          shortDescription: skill.shortDescription,
        })),
        [
          {
            name: "openclaw-review",
            path: "/Users/test/.agents/skills/openclaw-review/SKILL.md",
            enabled: true,
            shortDescription: "Review OpenClaw workflow changes.",
          },
          {
            name: "openclaw-triage",
            path: "/Users/test/.agents/skills/openclaw-triage/SKILL.md",
            enabled: true,
            shortDescription: "Triage OpenClaw routing issues.",
          },
        ],
      );
    }),
  );

  it.effect("reports the upgraded CLI without restarting a borrowed OpenCode server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settings = makeOpenCodeSettings();
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: settings.binaryPath,
          directory: process.cwd(),
        });
        yield* owner.withServer(() =>
          Effect.gen(function* () {
            runtimeMock.state.versionStdout = "opencode 1.14.20\n";
            const snapshot = yield* checkOpenCodeProviderStatus(
              settings,
              process.cwd(),
              probeOpenCodeRuntime(settings).pipe(
                Effect.provideService(
                  HttpClient.HttpClient,
                  replayOpenCodeServer(OPENCODE_1_RESPONSES, settings.serverPassword),
                ),
                Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, OpenCodeRuntimeTestDouble),
              ),
              Effect.succeed([]),
            ).pipe(Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, owner));

            NodeAssert.equal(snapshot.version, "1.14.19");
            NodeAssert.equal(snapshot.installedVersion, "1.14.20");
            NodeAssert.equal(runtimeMock.state.startCalls, 1);
            NodeAssert.equal(runtimeMock.state.closeCalls, 0);
          }),
        );
      }),
    ),
  );

  it.effect("lists a local OpenCode 2 binary's models in Full access only, never via 1.x", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionStdout = "opencode v2.0.18\n";
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        undefined,
        Effect.succeed([
          { providerID: "opencode", id: "big-pickle", name: "Big Pickle", variants: [] },
          {
            providerID: "opencode",
            id: "space-bunny-free",
            name: "Space Bunny Free",
            variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
          },
        ]),
      );

      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.equal(snapshot.version, "2.0.18");
      NodeAssert.equal("installedVersion" in snapshot, false);
      NodeAssert.deepEqual(snapshot.supportedRuntimeModes, [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]);
      NodeAssert.equal(snapshot.showInteractionModeToggle, true);
      NodeAssert.deepEqual(
        snapshot.slashCommands.map((command) => command.name),
        ["compact"],
      );
      NodeAssert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["opencode/big-pickle", "opencode/space-bunny-free"],
      );
      const variant = snapshot.models.find((model) => model.slug === "opencode/space-bunny-free")
        ?.capabilities?.optionDescriptors?.[0];
      NodeAssert.deepEqual(
        variant?.type === "select" ? variant.options.map((option) => option.id) : [],
        ["low", "medium", "high"],
      );
      NodeAssert.equal(runtimeMock.state.sdkClientInputs.length, 0);
    }),
  );

  it.effect("marks older releases of a family and deprecated models as legacy", () =>
    Effect.gen(function* () {
      const releases = [
        ["opencode", "opus-4-5", "claude-opus", "2025-11-24", "active"],
        ["opencode", "opus-5-5", "claude-opus", "2026-09-22", "active"],
        ["opencode", "opus-preview", "claude-opus", "2026-10-01", "deprecated"],
        ["opencode", "flash", "flash", "2026-09-10", "active"],
        ["opencode", "flash-free", "flash", "2026-09-10", "active"],
        ["opencode", "big-pickle", undefined, "2025-10-17", "active"],
        ["openrouter", "opus-4-5", "claude-opus", "2025-11-24", "active"],
      ] as const;
      const legacySlugs = (
        models: ReadonlyArray<{ readonly slug: string; readonly isLegacy?: boolean | undefined }>,
      ) =>
        models
          .filter((model) => model.isLegacy)
          .map((model) => model.slug)
          .toSorted();
      const expected = ["opencode/opus-4-5", "opencode/opus-preview"];

      runtimeMock.state.inventory = {
        providerList: {
          connected: ["opencode", "openrouter"],
          all: ["opencode", "openrouter"].map((providerID) => ({
            id: providerID,
            name: providerID,
            models: Object.fromEntries(
              releases
                .filter(([provider]) => provider === providerID)
                .map(([, id, family, releaseDate, status]) => [
                  id,
                  { id, name: id, family, release_date: releaseDate, status, variants: {} },
                ]),
            ),
          })),
          default: {},
        },
        agents: [],
      };
      NodeAssert.deepEqual(
        legacySlugs((yield* checkProvider(makeOpenCodeSettings())).models),
        expected,
      );

      runtimeMock.state.versionStdout = "opencode v2.0.18\n";
      const openCode2 = yield* checkProvider(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        undefined,
        Effect.succeed(
          releases.map(([providerID, id, family, releaseDate, status]) => ({
            providerID,
            id,
            name: id,
            variants: [],
            family,
            released: Date.parse(releaseDate),
            deprecated: status === "deprecated",
          })),
        ),
      );
      NodeAssert.deepEqual(legacySlugs(openCode2.models), expected);
    }),
  );

  it.effect("reports a failed OpenCode 2 model list without the server's response", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionStdout = "opencode v2.0.18\n";
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        undefined,
        Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "model.list",
            detail: 'status=500 body={"token":"leaked-response-body"}',
          }),
        ),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.message, "OpenCode could not load its model list.");
      NodeAssert.deepEqual(
        snapshot.slashCommands.map((command) => command.name),
        ["compact"],
      );
    }),
  );

  it.effect("reports local model inventory failures without treating them as empty", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionStdout = "opencode 1.14.20\n";
      runtimeMock.state.inventoryError = new Error("opencode models failed");
      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.version, "1.14.19");
      NodeAssert.equal(snapshot.installedVersion, "1.14.20");
      NodeAssert.equal(snapshot.models.length, 0);
      NodeAssert.equal(
        snapshot.message,
        "Failed to load OpenCode provider inventory: opencode models failed",
      );
    }),
  );
});

it.layer(layerTest)("checkOpenCodeProviderStatus with configured server URL", (it) => {
  it.effect.each([
    "401 Unauthorized",
    "403 Forbidden",
    "status=401 body={}",
    "status=403 body={}",
    "HTTP 401",
    "HTTP/1.1 403",
    "Response status code: 401",
    "Response status code: 403",
    "Request failed with status code 401",
    "Request failed with status code 403",
  ])("keeps explicit authentication rejection actionable: %s", (detail) =>
    Effect.gen(function* () {
      runtimeMock.state.connectionError = new Error(detail);
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999" }),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.auth.status, "unauthenticated");
      NodeAssert.equal(
        snapshot.message,
        "OpenCode server rejected authentication. Check the server URL and password.",
      );
    }),
  );

  it.effect.each([401, 403, 4010, 4030])("keeps connection failures on port %s retryable", (port) =>
    Effect.gen(function* () {
      const serverUrl = `http://127.0.0.1:${port}`;
      runtimeMock.state.connectionError = new Error(`connect ECONNREFUSED 127.0.0.1:${port}`);
      const snapshot = yield* checkProvider(makeOpenCodeSettings({ serverUrl }));

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.auth.status, "unknown");
      NodeAssert.equal(
        snapshot.message,
        `Couldn't reach the configured OpenCode server at ${serverUrl}. Check that the server is running and the URL is correct.`,
      );
    }),
  );

  it.effect("routes a configured OpenCode 2 server to the 2.x check, never via 1.x", () =>
    Effect.gen(function* () {
      const settings = makeOpenCodeSettings({
        serverUrl: "http://127.0.0.1:9999",
        serverPassword: "secret-password",
      });
      const snapshot = yield* checkProvider(
        settings,
        process.cwd(),
        undefined,
        replayOpenCodeServer(OPENCODE_2_RESPONSES, "secret-password"),
      );

      NodeAssert.equal(snapshot.status, "warning");
      NodeAssert.equal(snapshot.version, "2.0.18");
      NodeAssert.equal("installedVersion" in snapshot, false);
      NodeAssert.deepEqual(snapshot.supportedRuntimeModes, [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]);
      NodeAssert.equal(runtimeMock.state.sdkClientInputs.length, 0);
    }),
  );

  it.effect("reports a rejected OpenCode 2 password as an auth error, not a version", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999", serverPassword: "wrong" }),
        process.cwd(),
        undefined,
        replayOpenCodeServer(OPENCODE_2_RESPONSES, "secret-password"),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(
        snapshot.message,
        "OpenCode server rejected authentication. Check the server URL and password.",
      );
    }),
  );

  it.effect("rejects an unsupported server before loading inventory", () =>
    Effect.gen(function* () {
      runtimeMock.state.connectionError = new Error(
        "OpenCode v1.14.18 is too old. Upgrade to v1.14.19 or newer.",
      );
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999" }),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.models.length, 0);
      NodeAssert.match(snapshot.message ?? "", /v1\.14\.18 is too old/);
      NodeAssert.equal(runtimeMock.state.sdkClientInputs.length, 0);
    }),
  );
});

const builtinCommands = [
  { name: "init", description: "guided AGENTS.md setup" },
  { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
];

const builtinSkills = [
  { id: "opencode", name: "OpenCode", path: "/builtin/opencode.md" },
  { id: "report", name: "Report", path: "/builtin/report.md" },
];

const scanned: OpenCode2Workspace = {
  commands: [...builtinCommands, { name: "hello", description: "Say hello to the workspace" }],
  skills: [
    ...builtinSkills,
    {
      id: "greet",
      name: "greet",
      path: "/work/.opencode/skills/greet/SKILL.md",
      description: "Greets the user with the secret word MANGO.",
    },
  ],
};

it.effect("reads a fresh OpenCode 2 directory again once its scan has ended", () =>
  Effect.gen(function* () {
    const reads: Array<OpenCode2Workspace> = [{ commands: [], skills: [] }, scanned];
    const scanEnded = yield* Deferred.make<void>();
    const load = yield* loadOpenCode2Workspace(
      Effect.sync(() => reads.shift()!),
      Deferred.await(scanEnded),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    NodeAssert.equal(reads.length, 1);
    yield* Deferred.succeed(scanEnded, undefined);
    NodeAssert.deepEqual(yield* Fiber.join(load), scanned);
  }),
);
