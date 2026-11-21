import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { FxSettings } from "../settings.ts";
import { checkFxProviderStatus, readFxDefaultChoice } from "./status.ts";

const encoder = new TextEncoder();
const settings = Schema.decodeSync(FxSettings)({ enabled: true });

/** Holds stdout and the exit back until `answered` completes, like a CLI slow to answer. */
function processHandle(stdout: string, code: number, answered: Effect.Effect<void> = Effect.void) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_101),
    exitCode: Effect.as(answered, ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.unwrap(
      Effect.as(
        answered,
        stdout.length === 0 ? Stream.empty : Stream.succeed(encoder.encode(stdout)),
      ),
    ),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

// `fx status --json` and `fx models --json` from fx 0.0.15, trimmed to the
// fields T3 reads plus a few it ignores.
const status = (auth: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: "status", model: "default", auth, auth_refreshable: false, ...fields });
const models = (ids: ReadonlyArray<string>) =>
  JSON.stringify({ kind: "models", count: ids.length, private_models_hidden: false, ids });
const GATEWAY_MODELS = models(["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"]);
const SIGNED_OUT_LISTING = JSON.stringify({
  kind: "models",
  error: "could not list models: AuthenticationRejected",
  code: "AuthenticationRejected",
});

interface Invocation {
  readonly args: string;
  readonly backend: string | undefined;
  readonly cwd: string | undefined;
}

/**
 * Answers `fx` invocations keyed by `FX_PROVIDER` and arguments, such as
 * `codex status --json`; the unscoped status is ` status --json`. HOME holds
 * an fx profile whose settings define `profileProviders`, or `FX_HOME` does
 * when `profileInFxHome` is set.
 */
const check = (
  outputs: Record<string, string>,
  profileProviders: ReadonlyArray<string> = [],
  versionDelay: Duration.Input = 0,
  versionSpawned?: Deferred.Deferred<void>,
  profileInFxHome = false,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fx-status-" });
    const profile = path.join(home, profileInFxHome ? "fx-home" : ".fx");
    yield* fileSystem.makeDirectory(profile);
    yield* fileSystem.writeFileString(
      path.join(profile, "settings.json"),
      JSON.stringify({
        providers: Object.fromEntries(profileProviders.map((id) => [id, { protocol: "x" }])),
      }),
    );
    const invoked: Array<Invocation> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const standard = ChildProcess.isStandardCommand(command) ? command : undefined;
      const args = standard?.args.join(" ") ?? "";
      const backendValue = standard?.options.env?.FX_PROVIDER;
      const backend =
        typeof backendValue === "string" || backendValue === undefined
          ? backendValue
          : Redacted.value(backendValue);
      invoked.push({ args, backend, cwd: standard?.options.cwd });
      const stdout = args === "--version" ? "fx 0.0.15\n" : outputs[`${backend ?? ""} ${args}`];
      return Effect.gen(function* () {
        if (args === "--version" && versionSpawned)
          yield* Deferred.succeed(versionSpawned, undefined);
        return processHandle(
          stdout ?? "",
          stdout === undefined ? 2 : 0,
          args === "--version" ? Effect.sleep(versionDelay) : Effect.void,
        );
      });
    });
    const draft = yield* checkFxProviderStatus(
      settings,
      profileInFxHome ? { HOME: home, FX_HOME: profile } : { HOME: home },
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    return { draft, invoked };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("checkFxProviderStatus", () => {
  it.effect.each([
    {
      label: "answers after 6 s",
      versionDelay: "6 seconds",
      status: "ready",
      version: "0.0.15",
      message: undefined,
      invoked: [
        "--version",
        "status --json",
        "status --json",
        "status --json",
        "status --json",
        "models --json",
        "credits --json",
      ],
    },
    {
      label: "never answers",
      versionDelay: "Infinity",
      status: "error",
      version: null,
      message: "Failed to run `fx --version`.",
      invoked: ["--version"],
    },
  ] as const)("gives `fx --version` 10 s when it $label", (row) =>
    Effect.gen(function* () {
      const versionSpawned = yield* Deferred.make<void>();
      const fiber = yield* check(
        {
          " status --json": status("fx login"),
          "gateway status --json": status("fx login"),
          "gateway models --json": GATEWAY_MODELS,
          "codex status --json": status("missing"),
          "grok status --json": status("missing"),
        },
        [],
        row.versionDelay,
        versionSpawned,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(versionSpawned);
      yield* TestClock.adjust("10 seconds");
      const { draft, invoked } = yield* Fiber.join(fiber);
      assert.equal(draft.status, row.status);
      assert.equal(draft.version, row.version);
      assert.equal(draft.message, row.message);
      assert.deepEqual(invoked.map(({ args }) => args).toSorted(), [...row.invoked].toSorted());
    }),
  );

  it.effect("lists each backend's models and marks signed-out backends", () =>
    Effect.gen(function* () {
      const { draft, invoked } = yield* check(
        {
          " status --json": status("chatgpt subscription", {
            model: "gpt-5.5",
            model_source: "Codex subscription",
          }),
          "gateway status --json": status("fx login", { team: "example-team" }),
          "gateway models --json": GATEWAY_MODELS,
          "gateway credits --json": JSON.stringify({
            kind: "credits",
            balance: "12.50",
            token_pass: { remaining: "75", resets_at: "2026-12-05T08:00:00.000Z" },
          }),
          "codex status --json": status("chatgpt subscription"),
          "codex models --json": models(["gpt-5.5", "gpt-5.4-mini"]),
          "grok status --json": status("missing"),
          "local status --json": status("missing", {
            auth_help: "The configured provider credential is unavailable.",
          }),
        },
        ["local"],
      );
      // Never `fx acp`, which saves a session; signed-out backends list nothing, and only the
      // gateway has Token Pass credit, whichever backend is fx's default.
      assert.deepEqual(invoked.map(({ backend, args }) => `${backend ?? ""} ${args}`).toSorted(), [
        " --version",
        " status --json",
        "codex models --json",
        "codex status --json",
        "gateway credits --json",
        "gateway models --json",
        "gateway status --json",
        "grok status --json",
        "local status --json",
      ]);
      assert.equal(draft.status, "ready");
      assert.deepEqual(draft.auth, {
        status: "authenticated",
        label: "chatgpt subscription",
        workspaceId: "example-team",
      });
      assert.deepEqual(
        draft.models.map((model) => [model.slug, model.name, model.subProvider]),
        [
          ["default", "Default (gpt-5.5)", undefined],
          [
            "gateway:anthropic/claude-sonnet-5.5",
            "anthropic/claude-sonnet-5.5",
            "Vercel AI Gateway",
          ],
          ["gateway:anthropic/claude-opus-5.5", "anthropic/claude-opus-5.5", "Vercel AI Gateway"],
          ["codex:gpt-5.5", "gpt-5.5", "Codex subscription"],
          ["codex:gpt-5.4-mini", "gpt-5.4-mini", "Codex subscription"],
        ],
      );
      assert.deepEqual(draft.subProviders, [
        { name: "Vercel AI Gateway" },
        { name: "Codex subscription" },
        {
          name: "Grok subscription",
          unavailableReason: "Signed out. Run `fx login grok` on this machine.",
        },
        { name: "local", unavailableReason: "The configured provider credential is unavailable." },
      ]);
      assert.deepEqual(draft.usageLimits?.windows, [
        {
          id: "token_pass",
          kind: "monthly",
          label: "Token Pass",
          usedPercent: 50,
          resetsAt: "2026-12-05T08:00:00.000Z",
        },
      ]);
      assert.equal(draft.usageLimits?.credentialFingerprint, "vercel-team:example-team");
      assert.isDefined(draft.versionAdvisory);
    }),
  );

  it.effect("reads configured backends from the profile `FX_HOME` names", () =>
    Effect.gen(function* () {
      const { draft } = yield* check(
        {
          " status --json": status("fx login"),
          "gateway status --json": status("fx login"),
          "gateway models --json": GATEWAY_MODELS,
          "codex status --json": status("missing"),
          "grok status --json": status("missing"),
          "local status --json": status("fx login"),
          "local models --json": models([]),
        },
        ["local"],
        0,
        undefined,
        true,
      );
      assert.deepEqual(
        draft.subProviders?.map((subProvider) => subProvider.name),
        ["Vercel AI Gateway", "Codex subscription", "Grok subscription", "local"],
      );
    }),
  );

  it.effect("stays usable while fx's default backend is signed out", () =>
    Effect.gen(function* () {
      const { draft, invoked } = yield* check({
        " status --json": status("missing", { model: "spacexai/grok-4.7" }),
        "gateway status --json": status("missing"),
        "gateway models --json": GATEWAY_MODELS,
        "codex status --json": status("chatgpt subscription"),
        "codex models --json": models(["gpt-5.5"]),
        "grok status --json": status("missing"),
      });
      assert.equal(draft.status, "warning");
      assert.deepEqual(draft.auth, { status: "authenticated", label: "Codex subscription" });
      assert.equal(
        draft.message,
        "fx's default backend, Vercel AI Gateway, is signed out. Pick a model on another backend or sign in.",
      );
      // The gateway lists its public catalog signed out, but none of it can run.
      assert.deepEqual(
        draft.models.map((model) => model.slug),
        ["default", "codex:gpt-5.5"],
      );
      // A signed-out gateway has no credit to read, so Limits shows no fx row.
      assert.isFalse(invoked.some(({ args }) => args === "credits --json"));
      assert.isUndefined(draft.usageLimits);

      // An earlier backend whose sign-in fx could not report does not hide Codex's.
      const unreadable = yield* check({
        " status --json": status("missing", { model: "spacexai/grok-4.7" }),
        "gateway models --json": GATEWAY_MODELS,
        "codex status --json": status("chatgpt subscription"),
        "codex models --json": models(["gpt-5.5"]),
        "grok status --json": status("missing"),
      });
      assert.deepEqual(unreadable.draft.auth, {
        status: "authenticated",
        label: "Codex subscription",
      });
    }),
  );

  it.effect("offers Full access only when `fx status` lists that mode", () =>
    Effect.gen(function* () {
      const backends = {
        "gateway status --json": status("fx login"),
        "gateway models --json": GATEWAY_MODELS,
        "codex status --json": status("missing"),
        "grok status --json": status("missing"),
      };
      // fx 0.0.13 lists no modes and has no full-access mode.
      const withoutModes = yield* check({ ...backends, " status --json": status("fx login") });
      assert.deepEqual(withoutModes.draft.supportedRuntimeModes, ["approval-required", "auto"]);
      // fx 0.0.14+ lists the ACP session modes (src/core/output/output_contracts.zig).
      const withModes = yield* check({
        ...backends,
        " status --json": status("fx login", {
          modes: [{ id: "auto" }, { id: "ask" }, { id: "full-access" }],
        }),
      });
      assert.deepEqual(withModes.draft.supportedRuntimeModes, [
        "approval-required",
        "auto",
        "full-access",
      ]);
    }),
  );

  it.effect("reports a machine signed out of every backend", () =>
    Effect.gen(function* () {
      const signedOut = yield* check({
        " status --json": status("missing", { model: "spacexai/grok-4.7" }),
        "gateway status --json": status("missing"),
        "codex status --json": status("missing"),
        "codex models --json": SIGNED_OUT_LISTING,
        "grok status --json": status("missing"),
      });
      assert.equal(signedOut.draft.status, "error");
      assert.equal(signedOut.draft.auth.status, "unauthenticated");
      assert.equal(signedOut.draft.message, "Run `fx login` to sign in.");

      // An fx whose status output T3 cannot read is not reported as signed out.
      const unknown = yield* check({ " status --json": "not json" });
      assert.equal(unknown.draft.status, "warning");
      assert.equal(unknown.draft.auth.status, "unknown");
    }),
  );

  // A ready snapshot drops models it does not list, so only a real listing may report ready.
  it.effect("treats `fx models` output without ids as a failed listing", () =>
    Effect.gen(function* () {
      const outputs = (gatewayModels: string) => ({
        " status --json": status("fx login"),
        "gateway status --json": status("fx login"),
        "gateway models --json": gatewayModels,
        "codex status --json": status("chatgpt subscription"),
        "codex models --json": models(["gpt-5.5"]),
        "grok status --json": status("missing"),
      });
      const reshaped = yield* check(outputs(JSON.stringify({ kind: "models", models: [] })));
      assert.equal(reshaped.draft.status, "warning");
      assert.deepEqual(
        reshaped.draft.models.map((model) => model.slug),
        ["default", "codex:gpt-5.5"],
      );
      // The server keeps the gateway's earlier models, which can still run.
      assert.deepEqual(reshaped.draft.subProviders?.[0], { name: "Vercel AI Gateway" });

      const empty = yield* check(outputs(models([])));
      assert.equal(empty.draft.status, "ready");
    }),
  );
});

describe("readFxDefaultChoice", () => {
  // fx's settings can give one folder its own model, which `fx status` reports only there.
  it.effect("reads fx's default backend and model in the thread's folder", () =>
    Effect.forEach(
      [
        [{ model: "openai/gpt-5.5" }, { backend: "gateway", model: "openai/gpt-5.5" }],
        [
          { model: "gpt-5.5", model_source: "Codex subscription" },
          { backend: "codex", model: "gpt-5.5" },
        ],
        [
          { model: "llama3", model_source: "local" },
          { backend: "local", model: "llama3" },
        ],
      ] as const,
      ([fields, expected]) =>
        Effect.gen(function* () {
          const cwds: Array<string | undefined> = [];
          const spawner = ChildProcessSpawner.make((command) => {
            if (ChildProcess.isStandardCommand(command)) cwds.push(command.options.cwd);
            return Effect.succeed(processHandle(status("fx login", fields), 0));
          });
          const choice = yield* readFxDefaultChoice(settings, {}, "/work/project").pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          assert.deepEqual(choice, expected);
          assert.deepEqual(cwds, ["/work/project"]);
        }),
      { discard: true },
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
