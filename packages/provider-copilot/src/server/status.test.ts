import { assert, it } from "@effect/vitest";
import type { ModelInfo } from "@github/copilot-sdk";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type { CopilotSdkClient } from "./copilotSdkRuntime.ts";
import {
  gitHubCopilotAuth,
  gitHubCopilotModels,
  gitHubCopilotSlashCommands,
  readGitHubCopilotAccount,
} from "./status.ts";

const model = (overrides: Partial<ModelInfo>) =>
  ({ id: "m", name: "M", capabilities: {}, ...overrides }) as ModelInfo;

it("lists only usable models, each with its own reasoning levels", () => {
  const models = gitHubCopilotModels([
    model({
      id: "fast",
      name: "Fast",
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    }),
    model({ id: "plain", name: "Plain" }),
    model({ id: "blocked", policy: { state: "disabled", terms: "" } }),
  ]);

  assert.deepEqual(
    models.map((entry) => entry.slug),
    ["fast", "plain"],
  );
  const [descriptor] = models[0]?.capabilities?.optionDescriptors ?? [];
  assert.strictEqual(descriptor?.id, "reasoning_effort");
  assert.deepEqual(models[1]?.capabilities?.optionDescriptors, []);
});

it("keeps one /compact, since T3 runs compaction itself", () => {
  const commands = gitHubCopilotSlashCommands([
    { name: "compact", description: "Copilot's" },
    { name: "usage", description: "Show usage" },
  ]);

  assert.deepEqual(
    commands.map((command) => command.name),
    ["compact", "usage"],
  );
});

it("reports the signed-in account", () => {
  assert.deepEqual(gitHubCopilotAuth({ isAuthenticated: true, login: "octocat" }), {
    status: "authenticated",
    label: "octocat",
  });
  assert.deepEqual(gitHubCopilotAuth({ isAuthenticated: false }), { status: "unauthenticated" });
});

const probeClient = (overrides: Partial<CopilotSdkClient>) =>
  ({
    start: async () => undefined,
    authStatus: async () => ({ isAuthenticated: false }),
    stop: async () => undefined,
    forceStop: async () => undefined,
    ...overrides,
  }) as CopilotSdkClient;

it.effect("force stops a CLI that never finishes its handshake", () =>
  Effect.gen(function* () {
    let forced = false;
    const probe = yield* readGitHubCopilotAccount(
      probeClient({
        start: () => new Promise(() => undefined),
        forceStop: async () => {
          forced = true;
        },
      }),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust("30 seconds");

    assert.isTrue(Option.isNone(yield* Fiber.join(probe)));
    assert.isTrue(forced);
  }),
);

it.effect("force stops a CLI that will not shut down", () =>
  Effect.gen(function* () {
    let forced = false;
    const stopping = yield* Deferred.make<void>();
    const probe = yield* readGitHubCopilotAccount(
      probeClient({
        stop: () => {
          Deferred.doneUnsafe(stopping, Exit.void);
          return new Promise(() => undefined);
        },
        forceStop: async () => {
          forced = true;
        },
      }),
    ).pipe(Effect.forkChild);

    yield* Deferred.await(stopping);
    yield* TestClock.adjust("2 seconds");

    assert.isTrue(Option.isSome(yield* Fiber.join(probe)));
    assert.isTrue(forced);
  }),
);
