import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ServerSettings,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings.ts";
import { sweepOnce } from "./SettledAutoArchiveReactor.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const projectId = ProjectId.make("project-1");

const settledThread = (id: string, settledAt: string) =>
  ({
    id: ThreadId.make(id),
    projectId,
    parentThreadId: null,
    archivedAt: null,
    deletedAt: null,
    settledOverride: "settled",
    settledAt,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    latestTurn: null,
    session: null,
    messages: [],
    activities: [],
  }) as unknown as OrchestrationThread;

const readModel = (threads: ReadonlyArray<OrchestrationThread>) =>
  ({ projects: [], threads, workflowRuns: [] }) as unknown as OrchestrationReadModel;

const archiveThreadIdOf = (command: OrchestrationCommand): string | null =>
  command.type === "thread.archive" ? String(command.threadId) : null;

const harness = ({
  threads,
  settings = {},
  failSettings = false,
  failDispatchFor = [],
}: {
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly settings?: Partial<ServerSettings>;
  readonly failSettings?: boolean;
  readonly failDispatchFor?: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    const services = Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, {
        getReadModel: () => Effect.succeed(readModel(threads)),
        dispatch: (command: OrchestrationCommand) =>
          failDispatchFor.includes(archiveThreadIdOf(command) ?? "")
            ? Effect.fail({ _tag: "DispatchFailed" })
            : Ref.update(dispatched, (previous) => [...previous, command]).pipe(
                Effect.as({ sequence: 1 }),
              ),
      } as unknown as OrchestrationEngineShape),
      Layer.succeed(ServerSettingsService, {
        getSettings: failSettings
          ? Effect.fail({ _tag: "ServerSettingsError" })
          : Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              ...settings,
            } satisfies ServerSettings),
      } as unknown as ServerSettingsShape),
    );

    const run = Effect.provide(sweepOnce, services).pipe(Effect.asVoid);
    return { run, dispatched };
  });

const dueAt = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

describe("settled auto-archive sweepOnce", () => {
  it.effect("dispatches an automatic archive for a due settled thread", () =>
    Effect.gen(function* () {
      const h = yield* harness({ threads: [settledThread("root", dueAt(3))] });
      yield* h.run;
      const commands = yield* Ref.get(h.dispatched);
      assert.strictEqual(commands.length, 1);
      const command = commands[0];
      assert.strictEqual(command?.type, "thread.archive");
      assert.strictEqual(command?.type === "thread.archive" && command.automatic, true);
      assert.isTrue(
        command?.type === "thread.archive" &&
          String(command.commandId).startsWith("server:settled-archive:"),
      );
    }),
  );

  it.effect("leaves a freshly settled thread alone", () =>
    Effect.gen(function* () {
      const h = yield* harness({ threads: [settledThread("root", dueAt(1))] });
      yield* h.run;
      const commands = yield* Ref.get(h.dispatched);
      assert.strictEqual(commands.length, 0);
    }),
  );

  it.effect("honours a custom day count", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        threads: [settledThread("root", dueAt(6))],
        settings: { autoArchiveSettledAfterDays: 7 },
      });
      yield* h.run;
      const commands = yield* Ref.get(h.dispatched);
      assert.strictEqual(commands.length, 0);
    }),
  );

  it.effect("does nothing when the setting is null (never)", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        threads: [settledThread("root", dueAt(90))],
        settings: { autoArchiveSettledAfterDays: null },
      });
      yield* h.run;
      const commands = yield* Ref.get(h.dispatched);
      assert.strictEqual(commands.length, 0);
    }),
  );

  it.effect("does nothing when settings cannot be read", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        threads: [settledThread("root", dueAt(90))],
        failSettings: true,
      });
      yield* h.run;
      const commands = yield* Ref.get(h.dispatched);
      assert.strictEqual(commands.length, 0);
    }),
  );

  it.effect("continues past a dispatch failure", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        threads: [settledThread("first", dueAt(3)), settledThread("second", dueAt(4))],
        failDispatchFor: ["first"],
      });
      yield* h.run;
      const commands = yield* Ref.get(h.dispatched);
      assert.strictEqual(commands.length, 1);
      assert.strictEqual(archiveThreadIdOf(commands[0]!), "second");
    }),
  );
});
