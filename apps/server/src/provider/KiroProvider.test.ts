import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { KiroSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { checkKiroProviderStatus, kiroDefaultModelId } from "./KiroProvider.ts";

const encoder = new TextEncoder();
const settings = Schema.decodeSync(KiroSettings)({ enabled: true });

interface CliOutput {
  readonly stdout: string;
  readonly code: number;
}

function processHandle(output: CliOutput) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_002),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout:
      output.stdout.length === 0 ? Stream.empty : Stream.succeed(encoder.encode(output.stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/** Answers `kiro-cli` invocations by their arguments and records which ran. */
function kiroCli(outputs: Record<string, CliOutput>) {
  const invoked: Array<string> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args.join(" ") : "";
    invoked.push(args);
    return Effect.succeed(processHandle(outputs[args] ?? { stdout: "", code: 127 }));
  });
  return { invoked, spawner };
}

const check = (outputs: Record<string, CliOutput>) =>
  Effect.gen(function* () {
    const cli = kiroCli(outputs);
    const snapshot = yield* checkKiroProviderStatus(settings, {}).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
    );
    return { snapshot, invoked: cli.invoked };
  }).pipe(Effect.provide(NodeServices.layer));

describe("KiroProvider", () => {
  it.effect("reports a CLI whose version probe exits nonzero as failing to run", () =>
    Effect.gen(function* () {
      const { snapshot, invoked } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 1 },
      });
      assert.equal(snapshot.status, "error");
      assert.isTrue(snapshot.installed);
      assert.equal(snapshot.message, "Kiro CLI is installed but failed to run.");
      // A broken CLI is not asked for its sign-in.
      assert.deepEqual(invoked, ["--version"]);
    }),
  );

  // `whoami` outputs recorded from Kiro CLI 2.27.0.
  it.effect("asks for kiro-cli login when Kiro is signed out", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"account":null}\n', code: 1 },
      });
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "2.27.0");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.include(snapshot.message ?? "", "kiro-cli login");
    }),
  );

  it.effect("is ready once Kiro reports a signed-in account", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"accountType":"ApiKey","email":null}\n', code: 0 },
      });
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      // The version advisory is what the compatibility check and update UI read.
      assert.equal(snapshot.versionAdvisory?.currentVersion, "2.27.0");
      assert.isFalse(snapshot.versionAdvisory?.canUpdate);
    }),
  );

  // Shape of `kiro-cli chat --list-models --format json` on Kiro CLI 2.27.0, trimmed to three models.
  const KIRO_MODEL_LIST = JSON.stringify({
    models: [
      { model_name: "auto", model_id: "auto", description: "Models chosen by task" },
      { model_name: "claude-sonnet-4.5", model_id: "claude-sonnet-4.5" },
      { model_name: "claude-haiku-4.5", model_id: "claude-haiku-4.5" },
    ],
    default_model: "auto",
  });

  it.effect("lists the signed-in account's models with auto as the Kiro default", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"accountType":"SocialGitHub"}\n', code: 0 },
        "chat --list-models --format json": { stdout: `${KIRO_MODEL_LIST}\n`, code: 0 },
      });
      assert.deepEqual(
        snapshot.models.map((model) => [model.slug, model.isDefault === true]),
        [
          ["default", true],
          ["claude-sonnet-4.5", false],
          ["claude-haiku-4.5", false],
        ],
      );
    }),
  );

  it.effect("keeps the id Kiro's model list names as its default for Kiro default", () =>
    Effect.gen(function* () {
      const signedIn = {
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"accountType":"SocialGitHub"}\n', code: 0 },
      };
      const listed = yield* check({
        ...signedIn,
        "chat --list-models --format json": {
          stdout: KIRO_MODEL_LIST.replace(
            '"default_model":"auto"',
            '"default_model":"claude-sonnet-4.5"',
          ),
          code: 0,
        },
      });
      assert.equal(kiroDefaultModelId(listed.snapshot.models), "claude-sonnet-4.5");
      // An unparsable list keeps the built-in entry, which falls back to `auto`.
      const unlisted = yield* check({
        ...signedIn,
        "chat --list-models --format json": { stdout: "not json\n", code: 0 },
      });
      assert.equal(kiroDefaultModelId(unlisted.snapshot.models), "auto");
    }),
  );

  // `--list-models` names no effort levels, so the picker's come from Kiro's ids.
  const KIRO_EFFORT_MODEL_LIST = JSON.stringify({
    models: ["auto", "claude-opus-5.5", "claude-opus-4.6", "claude-sonnet-4.5"].map((id) => ({
      model_name: id,
      model_id: id,
    })),
    default_model: "auto",
  });

  it.effect("offers each model only the reasoning levels Kiro takes for it", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"accountType":"SocialGitHub"}\n', code: 0 },
        "chat --list-models --format json": { stdout: KIRO_EFFORT_MODEL_LIST, code: 0 },
      });
      const reasoning = snapshot.models.map((model) => {
        const descriptors = model.capabilities?.optionDescriptors ?? [];
        const select = descriptors.find((descriptor) => descriptor.id === "reasoningEffort");
        return select?.type === "select"
          ? {
              slug: model.slug,
              label: select.label,
              levels: select.options.map((choice) => choice.id),
              defaults: select.options.filter((choice) => choice.isDefault).map((c) => c.id),
              currentValue: select.currentValue,
            }
          : { slug: model.slug, descriptors: descriptors.length };
      });
      assert.deepEqual(reasoning, [
        // Kiro default and models without effort get no Reasoning select.
        { slug: "default", descriptors: 0 },
        {
          slug: "claude-opus-5.5",
          label: "Reasoning",
          levels: ["low", "medium", "high", "xhigh", "max"],
          defaults: ["medium"],
          currentValue: "medium",
        },
        // Opus 4.6 has no xhigh, and Kiro runs it at high by default.
        {
          slug: "claude-opus-4.6",
          label: "Reasoning",
          levels: ["low", "medium", "high", "max"],
          defaults: ["high"],
          currentValue: "high",
        },
        { slug: "claude-sonnet-4.5", descriptors: 0 },
      ]);
    }),
  );

  it.effect("never lists models while signed out, where listing would start a browser login", () =>
    Effect.gen(function* () {
      const { snapshot, invoked } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"account":null}\n', code: 1 },
        "chat --list-models --format json": { stdout: `${KIRO_MODEL_LIST}\n`, code: 0 },
      });
      assert.notInclude(invoked, "chat --list-models --format json");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
    }),
  );
});
