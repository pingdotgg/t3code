import {
  PluginCommandName,
  PluginId,
  PluginRouteId,
  PluginUiPlacementId,
  ProjectId,
  ThreadId,
} from "@t3tools/plugin-api/schema";
import {
  PluginRuntimeError,
  PluginStoreError,
  type PluginActivationContext,
} from "@t3tools/plugin-api/server";
import { assert, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import {
  AUTOMATIONS_COMMANDS,
  AUTOMATIONS_PLUGIN_ID,
  automationsPlugin,
  computeNextRunAt,
  isMissedRun,
  runAutomationScheduleTick,
  shouldFireSchedule,
  validateFiveFieldCron,
} from "./server/index.ts";
import { AutomationRunId, type AutomationRule, type AutomationRun } from "./shared/schema.ts";

class HarnessError extends Data.TaggedError("HarnessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface StoredCommand {
  readonly invoke: (input: unknown) => Effect.Effect<unknown, Error>;
  readonly decodeOutput: (output: unknown) => Effect.Effect<unknown, HarnessError>;
}

interface Harness {
  readonly ctx: PluginActivationContext;
  readonly documents: HarnessDocuments;
  readonly collections: Set<string>;
  readonly commands: Map<string, StoredCommand>;
  readonly launchedThreads: Array<{
    readonly projectId: ProjectId;
    readonly title: string;
    readonly prompt: string;
  }>;
  readonly publishedEvents: Array<unknown>;
  readonly badgeProviders: Map<string, () => Effect.Effect<number, Error>>;
}

interface HarnessDocuments {
  readonly list: <A>(collection: string) => Effect.Effect<ReadonlyArray<A>, PluginStoreError>;
  readonly get: <A>(
    collection: string,
    documentId: string,
  ) => Effect.Effect<A | null, PluginStoreError>;
  readonly upsert: <A>(
    collection: string,
    documentId: string,
    document: A,
  ) => Effect.Effect<void, PluginStoreError>;
  readonly delete: (
    collection: string,
    documentId: string,
  ) => Effect.Effect<void, PluginStoreError>;
}

function makeHarness(options?: {
  readonly createAndSendThread?: PluginActivationContext["runtime"]["createAndSendThread"];
}): Harness {
  const schemas = new Map<string, Schema.Codec<unknown, unknown>>();
  const documents = new Map<string, Map<string, unknown>>();
  const collections = new Set<string>();
  const commands = new Map<string, StoredCommand>();
  const launchedThreads: Harness["launchedThreads"] = [];
  const publishedEvents: Array<unknown> = [];
  const badgeProviders = new Map<string, () => Effect.Effect<number, Error>>();

  const requireSchema = (collection: string) =>
    Effect.sync(() => schemas.get(collection)).pipe(
      Effect.flatMap((schema) =>
        schema
          ? Effect.succeed(schema)
          : Effect.fail(new PluginStoreError(`Collection ${collection} is not registered.`)),
      ),
    );

  const decode = (collection: string, value: unknown) =>
    requireSchema(collection).pipe(
      Effect.flatMap((schema) => Schema.decodeUnknownEffect(schema)(value)),
      Effect.mapError((cause) => new PluginStoreError(`Invalid ${collection} document.`, cause)),
    );

  const collectionMap = (collection: string) => {
    let values = documents.get(collection);
    if (!values) {
      values = new Map<string, unknown>();
      documents.set(collection, values);
    }
    return values;
  };

  const documentStore: HarnessDocuments = {
    list: <A>(collection: string) =>
      Effect.gen(function* () {
        yield* requireSchema(collection);
        const values = Array.from(collectionMap(collection).values());
        return yield* Effect.forEach(values, (value) => decode(collection, value), {
          concurrency: 1,
        });
      }).pipe(Effect.map((values) => values as ReadonlyArray<A>)),
    get: <A>(collection: string, documentId: string) =>
      Effect.gen(function* () {
        yield* requireSchema(collection);
        const value = collectionMap(collection).get(documentId);
        if (value === undefined) {
          return null;
        }
        return (yield* decode(collection, value)) as A;
      }),
    upsert: (collection, documentId, document) =>
      decode(collection, document).pipe(
        Effect.flatMap((decoded) =>
          Effect.sync(() => {
            collectionMap(collection).set(documentId, decoded);
          }),
        ),
      ),
    delete: (collection, documentId) =>
      Effect.sync(() => {
        collectionMap(collection).delete(documentId);
      }),
  };

  const defaultCreateAndSendThread: PluginActivationContext["runtime"]["createAndSendThread"] = (
    input,
  ) =>
    Effect.sync(() => {
      launchedThreads.push(input);
      return { threadId: ThreadId.make(`thread-${launchedThreads.length}`) };
    });

  const ctx: PluginActivationContext = {
    pluginId: PluginId.make(AUTOMATIONS_PLUGIN_ID),
    store: {
      registerCollection: <A, I>(collection: string, schema: Schema.Codec<A, I>) =>
        Effect.sync(() => {
          collections.add(collection);
          schemas.set(collection, schema as Schema.Codec<unknown, unknown>);
          return {
            list: () => documentStore.list<A>(collection),
            get: (documentId: string) => documentStore.get<A>(collection, documentId),
            upsert: (documentId: string, document: A) =>
              documentStore.upsert<A>(collection, documentId, document),
            delete: (documentId: string) => documentStore.delete(collection, documentId),
          };
        }),
    },
    commands: {
      register: (command, registration) =>
        Effect.sync(() => {
          const decodeInput = Schema.decodeUnknownEffect(registration.input);
          const decodeOutput = Schema.decodeUnknownEffect(registration.output);
          commands.set(command, {
            invoke: (value) =>
              decodeInput(value).pipe(
                Effect.mapError(
                  (cause) =>
                    new HarnessError({
                      message: "Invalid command input.",
                      cause,
                    }),
                ),
                Effect.flatMap(registration.handler),
              ),
            decodeOutput: (value) =>
              decodeOutput(value).pipe(
                Effect.mapError(
                  (cause) =>
                    new HarnessError({
                      message: "Invalid command output.",
                      cause,
                    }),
                ),
              ),
          });
        }),
    },
    ui: {
      setPlacementBadgeProvider: (placementId, provider) =>
        Effect.sync(() => {
          badgeProviders.set(placementId, provider);
        }),
    },
    runtime: {
      createAndSendThread:
        options?.createAndSendThread ??
        ((input) =>
          defaultCreateAndSendThread(input).pipe(
            Effect.mapError((cause) => new PluginRuntimeError("Thread launch failed.", cause)),
          )),
    },
    events: {
      publish: (event) =>
        Effect.sync(() => {
          publishedEvents.push(event);
        }),
    },
  };

  return {
    ctx,
    documents: documentStore,
    collections,
    commands,
    launchedThreads,
    publishedEvents,
    badgeProviders,
  };
}

function commandName(command: (typeof AUTOMATIONS_COMMANDS)[keyof typeof AUTOMATIONS_COMMANDS]) {
  return PluginCommandName.make(command);
}

function invoke<T>(
  harness: Harness,
  command: (typeof AUTOMATIONS_COMMANDS)[keyof typeof AUTOMATIONS_COMMANDS],
  input: unknown,
) {
  return Effect.gen(function* () {
    const registration = harness.commands.get(commandName(command));
    if (!registration) {
      return yield* new HarnessError({
        message: `Command ${command} was not registered.`,
      });
    }
    const output = yield* registration.invoke(input);
    return (yield* registration.decodeOutput(output)) as T;
  });
}

const projectId = ProjectId.make("project-automations-test");

const createRuleInput = {
  name: "Daily check",
  enabled: true,
  projectId,
  cron: "0 9 * * *",
  timezone: "UTC",
  prompt: "Summarize the repo state.",
};

it("Automations cron policy helpers", () => {
  assert.equal(
    computeNextRunAt({
      cron: "0 9 * * *",
      timezone: "America/New_York",
      afterIso: "2026-01-01T00:00:00.000Z",
    }),
    "2026-01-01T14:00:00.000Z",
  );

  let cronError: unknown;
  try {
    validateFiveFieldCron("0 0 9 * * *", "UTC");
  } catch (error) {
    cronError = error;
  }
  assert.instanceOf(cronError, Error);

  assert.isTrue(
    shouldFireSchedule({
      nextRunAt: "2026-01-01T14:00:00.000Z",
      nowIso: "2026-01-01T14:00:42.000Z",
    }),
  );
  assert.isTrue(
    isMissedRun({
      nextRunAt: "2026-01-01T14:00:00.000Z",
      nowIso: "2026-01-01T14:05:00.000Z",
    }),
  );
  assert.isFalse(
    shouldFireSchedule({
      nextRunAt: "2026-01-01T14:00:00.000Z",
      nowIso: "2026-01-01T14:05:00.000Z",
    }),
  );
});

it.effect(
  "Automations plugin registers its manifest slice, commands, collections, and badge provider",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness();

      yield* automationsPlugin.activate(harness.ctx);

      assert.equal(automationsPlugin.manifest.id, PluginId.make(AUTOMATIONS_PLUGIN_ID));
      assert.equal(automationsPlugin.manifest.routes[0]?.id, PluginRouteId.make("main"));
      assert.isTrue(harness.collections.has("rules"));
      assert.isTrue(harness.collections.has("runs"));
      assert.isTrue(harness.collections.has("scheduleState"));
      assert.equal(harness.commands.size, automationsPlugin.manifest.commands.length);
      assert.isFunction(harness.badgeProviders.get(PluginUiPlacementId.make("main-sidebar")));
    }),
);

it.effect("Automations rule CRUD persists schedule state and hard deletes run history", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* automationsPlugin.activate(harness.ctx);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    const scheduleState = yield* harness.documents.get<{ readonly nextRunAt: string }>(
      "scheduleState",
      created.rule.id,
    );
    assert.isString(scheduleState?.nextRunAt);

    const updated = yield* invoke<{
      readonly rule: { readonly name: string; readonly enabled: boolean };
    }>(harness, AUTOMATIONS_COMMANDS.rulesUpdate, {
      ruleId: created.rule.id,
      patch: {
        name: "Daily disabled check",
        enabled: false,
      },
    });
    assert.equal(updated.rule.name, "Daily disabled check");
    assert.isFalse(updated.rule.enabled);
    assert.isNull(yield* harness.documents.get("scheduleState", created.rule.id));

    yield* invoke(harness, AUTOMATIONS_COMMANDS.rulesRunNow, {
      ruleId: created.rule.id,
    });
    const beforeDelete = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    assert.equal(beforeDelete.runs.length, 1);

    yield* invoke(harness, AUTOMATIONS_COMMANDS.rulesDelete, {
      ruleId: created.rule.id,
    });
    assert.isNull(yield* harness.documents.get("scheduleState", created.rule.id));

    const afterDeleteRules = yield* invoke<{
      readonly rules: ReadonlyArray<unknown>;
    }>(harness, AUTOMATIONS_COMMANDS.rulesList, {});
    const afterDeleteRuns = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    assert.deepEqual(afterDeleteRules.rules, []);
    assert.deepEqual(afterDeleteRuns.runs, []);
  }),
);

it.effect("Automations run-now creates a new thread and records a completed manual run", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* automationsPlugin.activate(harness.ctx);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    const result = yield* invoke<{ readonly run: AutomationRun }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesRunNow,
      { ruleId: created.rule.id },
    );

    assert.equal(result.run.status, "completed");
    assert.equal(result.run.reason, "manual");
    assert.equal(result.run.threadId, ThreadId.make("thread-1"));
    assert.equal(harness.launchedThreads.length, 1);
    assert.equal(harness.launchedThreads[0]?.projectId, projectId);
    assert.match(harness.launchedThreads[0]?.title ?? "", /^Daily check - /);
  }),
);

it.effect("Automations scheduled tick creates a schedule run and thread", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* automationsPlugin.activate(harness.ctx);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    yield* harness.documents.upsert("scheduleState", created.rule.id, {
      ruleId: created.rule.id,
      nextRunAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-01-01T08:59:00.000Z",
    });
    yield* runAutomationScheduleTick(harness.ctx, "2026-01-01T09:00:10.000Z");

    const runs = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    assert.equal(runs.runs[0]?.status, "completed");
    assert.equal(runs.runs[0]?.reason, "schedule");
    assert.equal(harness.launchedThreads.length, 1);
  }),
);

it.effect("Automations overlap policy records skipped runs without launching a thread", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* automationsPlugin.activate(harness.ctx);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    yield* harness.documents.upsert<AutomationRun>("runs", "run-active", {
      id: AutomationRunId.make("run-active"),
      ruleId: created.rule.id,
      status: "running",
      reason: "manual",
      scheduledFor: "2026-01-01T09:00:00.000Z",
      startedAt: "2026-01-01T09:00:01.000Z",
    });

    const result = yield* invoke<{ readonly run: AutomationRun }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesRunNow,
      { ruleId: created.rule.id },
    );

    assert.equal(result.run.status, "skipped");
    assert.equal(result.run.reason, "previous-run-active");
    assert.equal(harness.launchedThreads.length, 0);
  }),
);

it.effect("Automations concurrent run-now requests use the overlap policy", () =>
  Effect.gen(function* () {
    const firstThreadStarted = yield* Deferred.make<void>();
    const releaseFirstThread = yield* Deferred.make<void>();
    let launchedThreadCount = 0;
    const harness = makeHarness({
      createAndSendThread: () =>
        Effect.gen(function* () {
          launchedThreadCount += 1;
          yield* Deferred.succeed(firstThreadStarted, undefined);
          yield* Deferred.await(releaseFirstThread);
          return { threadId: ThreadId.make(`thread-${launchedThreadCount}`) };
        }),
    });
    yield* automationsPlugin.activate(harness.ctx);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    const firstRun = yield* invoke<{ readonly run: AutomationRun }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesRunNow,
      { ruleId: created.rule.id },
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(firstThreadStarted);

    const secondRun = yield* invoke<{ readonly run: AutomationRun }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesRunNow,
      { ruleId: created.rule.id },
    );

    assert.equal(secondRun.run.status, "skipped");
    assert.equal(secondRun.run.reason, "previous-run-active");
    assert.equal(launchedThreadCount, 1);

    yield* Deferred.succeed(releaseFirstThread, undefined);
    const completedFirstRun = yield* Fiber.join(firstRun);
    assert.equal(completedFirstRun.run.status, "completed");
  }),
);

it.effect("Automations deleting an active rule does not recreate run history", () =>
  Effect.gen(function* () {
    const firstThreadStarted = yield* Deferred.make<void>();
    const releaseFirstThread = yield* Deferred.make<void>();
    const harness = makeHarness({
      createAndSendThread: () =>
        Deferred.succeed(firstThreadStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirstThread)),
          Effect.as({ threadId: ThreadId.make("thread-active-delete") }),
        ),
    });
    yield* automationsPlugin.activate(harness.ctx);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    const running = yield* invoke<{ readonly run: AutomationRun }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesRunNow,
      { ruleId: created.rule.id },
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(firstThreadStarted);

    yield* invoke(harness, AUTOMATIONS_COMMANDS.rulesDelete, {
      ruleId: created.rule.id,
    });
    yield* Deferred.succeed(releaseFirstThread, undefined);
    yield* Fiber.join(running);

    const runs = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    assert.deepEqual(runs.runs, []);
  }),
);

it.effect("Automations retains only the last 100 runs per rule", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* automationsPlugin.activate(harness.ctx);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    for (let index = 0; index < 101; index += 1) {
      const id = AutomationRunId.make(`run-stale-${index}`);
      yield* harness.documents.upsert<AutomationRun>("runs", id, {
        id,
        ruleId: created.rule.id,
        status: "completed",
        reason: "schedule",
        scheduledFor: `2026-01-01T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
        completedAt: `2026-01-01T${String(index % 24).padStart(2, "0")}:01:00.000Z`,
      });
    }

    yield* invoke(harness, AUTOMATIONS_COMMANDS.rulesRunNow, {
      ruleId: created.rule.id,
    });

    const runs = yield* invoke<{ readonly runs: ReadonlyArray<AutomationRun> }>(
      harness,
      AUTOMATIONS_COMMANDS.runsListRecent,
      { ruleId: created.rule.id, limit: 500 },
    );
    assert.equal(runs.runs.length, 100);
  }),
);
