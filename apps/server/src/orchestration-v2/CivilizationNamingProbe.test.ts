/**
 * Phase 0 G5 probe (disposable experiment, not feature implementation).
 *
 * Exercises the two boundaries required by Civilization naming:
 * - feature-owned transactional name allocation with normalized uniqueness and
 *   deterministic thread-derived collision suffixes; and
 * - the host title command boundary, where regeneration request ownership and
 *   explicit title edits decide whether Civilization still owns composition.
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:g5");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "g5-probe-model" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("G5 never starts a provider process"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerProbe = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "civilization-g5-naming" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const normalizeName = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US");

const threadSuffixes = (threadId: ThreadId): ReadonlyArray<string> => {
  const source = threadId.replace(/[^a-z0-9]/gi, "").toLocaleLowerCase("en-US");
  const lengths = [4, 8, 12, source.length];
  return [...new Set(lengths.map((length) => source.slice(-length)))];
};

const ensureNamingSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS civilization_g5_names (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    base_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    stable_entry_id TEXT NOT NULL,
    generator_version INTEGER NOT NULL,
    config_revision INTEGER NOT NULL,
    draw_count INTEGER NOT NULL,
    UNIQUE(project_id, name_key)
  )`;
});

type NameRow = {
  readonly thread_id: string;
  readonly project_id: string;
  readonly base_name: string;
  readonly display_name: string;
  readonly name_key: string;
  readonly stable_entry_id: string;
  readonly generator_version: number;
  readonly config_revision: number;
  readonly draw_count: number;
};

const assignName = (input: {
  readonly threadId: ThreadId;
  readonly baseName: string;
  readonly stableEntryId: string;
  readonly configRevision: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<NameRow>`
          SELECT * FROM civilization_g5_names WHERE thread_id = ${input.threadId}
        `;
        if (existing[0] !== undefined) return existing[0];

        const candidates = [
          input.baseName,
          ...threadSuffixes(input.threadId).map((suffix) => `${input.baseName}~${suffix}`),
        ];
        for (const displayName of candidates) {
          const nameKey = normalizeName(displayName);
          const collision = yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM civilization_g5_names
            WHERE project_id = ${projectId} AND name_key = ${nameKey}
          `;
          if (collision.length > 0) continue;
          yield* sql`INSERT INTO civilization_g5_names (
            thread_id, project_id, base_name, display_name, name_key,
            stable_entry_id, generator_version, config_revision, draw_count
          ) VALUES (
            ${input.threadId}, ${projectId}, ${input.baseName}, ${displayName}, ${nameKey},
            ${input.stableEntryId}, 1, ${input.configRevision}, 1
          )`;
          const inserted = yield* sql<NameRow>`
            SELECT * FROM civilization_g5_names WHERE thread_id = ${input.threadId}
          `;
          return inserted[0]!;
        }
        return yield* Effect.die(`Could not derive a unique name for ${input.threadId}`);
      }),
    );
  });

type TitleState = {
  readonly threadId: ThreadId;
  readonly name: string;
  topic: string;
  managed: boolean;
  enabled: boolean;
  preservedTitle: string | null;
  lastManagedTitle: string | null;
  revision: number;
};

const composeTitle = (state: Pick<TitleState, "name" | "topic">) =>
  `[${state.name}] ${state.topic}`;

function makeTitleOwnership(orchestrator: Orchestrator.OrchestratorV2["Service"]) {
  const states = new Map<ThreadId, TitleState>();

  const adopt = (threadId: ThreadId, name: string) =>
    Effect.gen(function* () {
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const state: TitleState = {
        threadId,
        name,
        topic: projection.thread.title,
        managed: false,
        enabled: true,
        preservedTitle: projection.thread.title,
        lastManagedTitle: null,
        revision: 1,
      };
      states.set(threadId, state);
      return state;
    });

  const enrollManaged = (threadId: ThreadId, name: string, topic: string) => {
    const state: TitleState = {
      threadId,
      name,
      topic,
      managed: true,
      enabled: true,
      preservedTitle: null,
      lastManagedTitle: `[${name}] ${topic}`,
      revision: 1,
    };
    states.set(threadId, state);
    return state;
  };

  const explicitDispatch = (command: OrchestrationV2ServerCommand) =>
    Effect.gen(function* () {
      const result = yield* orchestrator.dispatch(command);
      if (command.type === "thread.metadata.update" && command.title !== undefined) {
        const state = states.get(command.threadId);
        if (state !== undefined) {
          state.managed = false;
          state.preservedTitle = command.title;
          state.revision += 1;
        }
      }
      return result;
    });

  const generationComplete = (input: {
    readonly commandId: string;
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly generatedTitle?: string;
  }) =>
    Effect.gen(function* () {
      const projection = yield* orchestrator.getThreadProjection(input.threadId);
      const state = states.get(input.threadId);
      const ownsRequest = projection.thread.titleRegeneration?.requestId === input.requestId;
      const generatedTitle = input.generatedTitle;
      const managedTitle =
        ownsRequest && state?.enabled === true && state.managed && generatedTitle !== undefined
          ? composeTitle({ name: state.name, topic: generatedTitle })
          : generatedTitle;
      const title = ownsRequest && state?.enabled === false ? undefined : managedTitle;
      const result = yield* orchestrator.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make(input.commandId),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(title === undefined ? {} : { title }),
      });
      if (ownsRequest && state?.enabled === true && state.managed && generatedTitle !== undefined) {
        state.topic = generatedTitle;
        state.lastManagedTitle = managedTitle!;
        state.revision += 1;
      }
      return result;
    });

  const setEnabled = (threadId: ThreadId, enabled: boolean) => {
    const state = states.get(threadId);
    assert.isDefined(state);
    state!.enabled = enabled;
    state!.revision += 1;
  };

  const restore = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const state = states.get(threadId);
      assert.isDefined(state);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      if (
        state!.lastManagedTitle !== null &&
        state!.preservedTitle !== null &&
        projection.thread.title === state!.lastManagedTitle
      ) {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`g5:restore:${state!.revision}`),
          threadId,
          title: state!.preservedTitle,
        });
      }
      state!.managed = false;
      state!.preservedTitle = (yield* orchestrator.getThreadProjection(threadId)).thread.title;
      state!.revision += 1;
    });

  const reclaim = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const state = states.get(threadId);
      assert.isDefined(state);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      // Reclaim is explicit. If manual ownership was active, the current host
      // title is the freshest task topic and becomes the new composition seed.
      if (!state!.managed) state!.topic = projection.thread.title;
      state!.preservedTitle = projection.thread.title;
      state!.managed = true;
      const managedTitle = composeTitle(state!);
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`g5:reclaim:${state!.revision}`),
        threadId,
        title: managedTitle,
      });
      state!.lastManagedTitle = managedTitle;
      state!.revision += 1;
    });

  return {
    states,
    adopt,
    enrollManaged,
    explicitDispatch,
    generationComplete,
    setEnabled,
    restore,
    reclaim,
  };
}

const createThread = (threadId: ThreadId, title: string) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`g5:create:${threadId}`),
        threadId,
        projectId,
        title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      }),
    ),
    Effect.asVoid,
  );

const armGeneration = (threadId: ThreadId, commandId: string) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) => {
      const requestId = CommandId.make(commandId);
      return orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: requestId,
          threadId,
          regenerateTitle: true,
        })
        .pipe(Effect.as(requestId));
    }),
  );

it.effect(
  "allocates one stable draw per citizen under concurrent collisions and a one-entry pool",
  () =>
    Effect.gen(function* () {
      yield* ensureNamingSchema;
      const baseHolder = yield* assignName({
        threadId: ThreadId.make("thread:g5:base0000"),
        baseName: "Ada",
        stableEntryId: "name:ada",
        configRevision: 7,
      });
      assert.equal(baseHolder.display_name, "Ada");

      const [left, right] = yield* Effect.all(
        [
          assignName({
            threadId: ThreadId.make("thread:g5:1111dead"),
            baseName: "Ada",
            stableEntryId: "name:ada",
            configRevision: 7,
          }),
          assignName({
            threadId: ThreadId.make("thread:g5:2222dead"),
            baseName: "Ada",
            stableEntryId: "name:ada",
            configRevision: 7,
          }),
        ],
        { concurrency: "unbounded" },
      );
      assert.notEqual(left.name_key, right.name_key);
      assert.isTrue([left.display_name, right.display_name].includes("Ada~dead"));
      assert.isTrue(
        [left.display_name, right.display_name].some(
          (name) => name === "Ada~1111dead" || name === "Ada~2222dead",
        ),
      );
      for (const row of [baseHolder, left, right]) {
        assert.equal(row.base_name, "Ada");
        assert.equal(row.stable_entry_id, "name:ada");
        assert.equal(row.generator_version, 1);
        assert.equal(row.config_revision, 7);
        assert.equal(row.draw_count, 1);
      }

      const retry = yield* assignName({
        threadId: ThreadId.make(left.thread_id),
        baseName: "Grace",
        stableEntryId: "name:grace",
        configRevision: 8,
      });
      assert.deepEqual(retry, left);

      const exhaustedPoolBirth = yield* assignName({
        threadId: ThreadId.make("thread:g5:3333dead"),
        baseName: "Ada",
        stableEntryId: "name:ada",
        configRevision: 7,
      });
      assert.equal(exhaustedPoolBirth.draw_count, 1);
      assert.match(exhaustedPoolBirth.display_name, /^Ada~/);
    }).pipe(Effect.provide(Layer.fresh(layerProbe))),
);

it.effect(
  "uses host regeneration ownership so stale completions and explicit renames cannot steal managed titles",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ownership = makeTitleOwnership(orchestrator);
      const threadId = ThreadId.make("thread:g5:managed");
      yield* createThread(threadId, "[Ada] New thread");
      ownership.enrollManaged(threadId, "Ada", "New thread");

      const staleRequest = yield* armGeneration(threadId, "g5:title:stale");
      const currentRequest = yield* armGeneration(threadId, "g5:title:current");
      yield* ownership.generationComplete({
        commandId: "g5:title:stale:complete",
        threadId,
        requestId: staleRequest,
        generatedTitle: "Stale topic",
      });
      assert.equal(ownership.states.get(threadId)?.topic, "New thread");
      assert.equal(
        (yield* projectionStore.getThread(threadId)).titleRegeneration?.requestId,
        currentRequest,
      );

      yield* ownership.generationComplete({
        commandId: "g5:title:current:complete",
        threadId,
        requestId: currentRequest,
        generatedTitle: "Fresh topic",
      });
      assert.equal((yield* projectionStore.getThread(threadId)).title, "[Ada] Fresh topic");
      assert.equal(ownership.states.get(threadId)?.topic, "Fresh topic");

      const renamedRequest = yield* armGeneration(threadId, "g5:title:rename-race");
      yield* ownership.explicitDispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("g5:title:manual-rename"),
        threadId,
        title: "Manual ownership wins",
      });
      yield* ownership.generationComplete({
        commandId: "g5:title:rename-race:complete",
        threadId,
        requestId: renamedRequest,
        generatedTitle: "Too late",
      });
      assert.equal((yield* projectionStore.getThread(threadId)).title, "Manual ownership wins");
      assert.isFalse(ownership.states.get(threadId)!.managed);
      assert.equal(ownership.states.get(threadId)?.topic, "Fresh topic");
    }).pipe(Effect.provide(Layer.fresh(layerProbe))),
);

it.effect(
  "preserves explicit adoption titles and guards disable, restore and explicit reclaim",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ownership = makeTitleOwnership(orchestrator);

      const adoptionId = ThreadId.make("thread:g5:adoption");
      yield* createThread(adoptionId, "Existing explicit title");
      yield* Effect.all(
        [
          ownership.adopt(adoptionId, "Grace"),
          ownership.explicitDispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("g5:adoption:rename"),
            threadId: adoptionId,
            title: "Rename during adoption",
          }),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal((yield* projectionStore.getThread(adoptionId)).title, "Rename during adoption");
      assert.isFalse(ownership.states.get(adoptionId)!.managed);

      yield* ownership.reclaim(adoptionId);
      const managed = ownership.states.get(adoptionId)!;
      assert.isTrue(managed.managed);
      assert.equal((yield* projectionStore.getThread(adoptionId)).title, managed.lastManagedTitle);

      ownership.setEnabled(adoptionId, false);
      const titleBeforeDisabledGeneration = (yield* projectionStore.getThread(adoptionId)).title;
      const disabledRequest = yield* armGeneration(adoptionId, "g5:disabled:generation");
      yield* ownership.generationComplete({
        commandId: "g5:disabled:generation:complete",
        threadId: adoptionId,
        requestId: disabledRequest,
        generatedTitle: "Should not land while disabled",
      });
      assert.equal(
        (yield* projectionStore.getThread(adoptionId)).title,
        titleBeforeDisabledGeneration,
      );
      assert.equal(ownership.states.get(adoptionId)?.topic, "Rename during adoption");

      yield* ownership.restore(adoptionId);
      assert.equal((yield* projectionStore.getThread(adoptionId)).title, "Rename during adoption");
      assert.isFalse(ownership.states.get(adoptionId)!.managed);

      ownership.setEnabled(adoptionId, true);
      yield* ownership.reclaim(adoptionId);
      const lastManaged = ownership.states.get(adoptionId)!.lastManagedTitle;
      assert.equal((yield* projectionStore.getThread(adoptionId)).title, lastManaged);
      ownership.setEnabled(adoptionId, false);
      yield* ownership.explicitDispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("g5:disabled:later-edit"),
        threadId: adoptionId,
        title: "Later explicit edit",
      });
      yield* ownership.restore(adoptionId);
      assert.equal((yield* projectionStore.getThread(adoptionId)).title, "Later explicit edit");
      assert.notEqual((yield* projectionStore.getThread(adoptionId)).title, lastManaged);
    }).pipe(Effect.provide(Layer.fresh(layerProbe))),
);
