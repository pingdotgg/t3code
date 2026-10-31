import { assert, describe, it } from "@effect/vitest";
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OpenCode2OrchestratorReplayHarness } from "../Adapters/OpenCode2AdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { findReplayFixture, runReplayFixture } from "./ProviderReplayFixtures.ts";

// Evidence driver for #19228: replays recorded OpenCode 2 fixtures through
// OrchestratorV2 and records the adapter's own event stream, because the
// `pendingBackgroundWork` flag is dropped before it reaches domain events.
// Set EV_TRANSCRIPT to a file path to append the transcript there.

type Row = {
  readonly id: string;
  readonly fixture: string;
  /** True when every native thread must end on a `pendingBackgroundWork: false` snapshot. */
  readonly requireSettledSnapshots: boolean;
};

const ROWS: ReadonlyArray<Row> = [
  { id: "R1", fixture: "opencode2_nested_background", requireSettledSnapshots: true },
  { id: "R1-compat", fixture: "opencode2_background", requireSettledSnapshots: true },
  { id: "R2c-compat", fixture: "opencode2_resume_after_restart", requireSettledSnapshots: false },
  { id: "R2c-compat", fixture: "opencode2_interrupt", requireSettledSnapshots: false },
  { id: "R3", fixture: "opencode2_simple", requireSettledSnapshots: false },
  { id: "R3", fixture: "opencode2_tool_call", requireSettledSnapshots: false },
];

const tasksOf = (tasks: ReadonlyArray<{ readonly taskId: string }> | undefined) =>
  `[${(tasks ?? []).map((task) => task.taskId).join(",")}]`;

const describeEvent = (event: ProviderAdapter.ProviderAdapterV2Event): string | undefined => {
  switch (event.type) {
    case "provider_thread.updated":
      return `provider_thread.updated native=${event.providerThread.nativeThreadRef?.nativeId ?? "?"} pendingBackgroundWork=${String(event.pendingBackgroundWork)} pendingBackgroundTasks=${tasksOf(event.providerThread.pendingBackgroundTasks)}`;
    case "provider_turn.updated":
      return `provider_turn.updated native=${event.providerTurn.nativeTurnRef?.nativeId ?? "?"} status=${event.providerTurn.status}`;
    case "subagent.updated":
      return `subagent.updated title=${event.subagent.title ?? "?"} status=${event.subagent.status}`;
    case "turn.terminal":
      return `turn.terminal status=${event.status}`;
    default:
      return undefined;
  }
};

const tappedHarness = (
  record: (event: ProviderAdapter.ProviderAdapterV2Event) => void,
): typeof OpenCode2OrchestratorReplayHarness => ({
  ...OpenCode2OrchestratorReplayHarness,
  makeProviderAdapterRegistryLayer: (
    ...args: Parameters<typeof OpenCode2OrchestratorReplayHarness.makeProviderAdapterRegistryLayer>
  ) =>
    Layer.effect(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      Effect.gen(function* () {
        const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
        return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          ...registry,
          get: (instanceId: ProviderInstanceId) =>
            registry.get(instanceId).pipe(
              Effect.map((adapter) =>
                ProviderAdapter.ProviderAdapterV2.of({
                  ...adapter,
                  openSession: (input) =>
                    adapter.openSession(input).pipe(
                      Effect.map((runtime) => ({
                        ...runtime,
                        events: runtime.events.pipe(
                          Stream.tap((event) => Effect.sync(() => record(event))),
                        ),
                      })),
                    ),
                }),
              ),
            ),
        });
      }),
    ).pipe(
      Layer.provide(OpenCode2OrchestratorReplayHarness.makeProviderAdapterRegistryLayer(...args)),
    ),
});

const runRow = (row: Row) =>
  Effect.gen(function* () {
    const fixture = findReplayFixture(row.fixture);
    const driver = fixture?.providers.find((provider) => provider.driver === "opencode");
    assert.isDefined(fixture);
    assert.isDefined(driver);
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    const lines: Array<string> = [];
    const emit = (line: string) => lines.push(line);
    emit(`== ${row.id} ${row.fixture} (recorded fixture) ==`);
    const exit = yield* runReplayFixture({
      fixtureName: row.fixture,
      buildInput: fixture.buildInput,
      driver,
      harness: tappedHarness((event) => events.push(event)),
    }).pipe(Effect.exit);
    let index = 0;
    for (const event of events) {
      const line = describeEvent(event);
      if (line !== undefined) emit(`  adapter[${index}] ${line}`);
      index += 1;
    }
    const lastSnapshot = new Map<string, boolean | undefined>();
    let everPending = false;
    for (const event of events) {
      if (event.type !== "provider_thread.updated") continue;
      const nativeId = event.providerThread.nativeThreadRef?.nativeId ?? "?";
      lastSnapshot.set(nativeId, event.pendingBackgroundWork);
      if (event.pendingBackgroundWork === true) everPending = true;
    }
    const finals = [...lastSnapshot].map(([id, flag]) => `${id}=${String(flag)}`).join(" ");
    emit(`  final snapshot per native thread: ${finals}`);
    if (exit._tag === "Success") {
      for (const domain of exit.value.domainEvents) {
        if (domain.type !== "provider-thread.updated") continue;
        emit(
          `  domain provider-thread.updated native=${domain.payload.nativeThreadRef?.nativeId ?? "?"} pendingBackgroundTasks=${tasksOf(domain.payload.pendingBackgroundTasks)}`,
        );
      }
    }
    const failures: Array<string> = [];
    if (exit._tag === "Failure") failures.push("fixture output assertions failed");
    if (row.requireSettledSnapshots) {
      if (!everPending) failures.push("no pendingBackgroundWork=true snapshot was published");
      for (const [id, flag] of lastSnapshot) {
        if (flag !== false) failures.push(`${id} ended on pendingBackgroundWork=${String(flag)}`);
      }
    } else if ([...lastSnapshot.values()].includes(true)) {
      failures.push("a native thread ended with pending work");
    }
    emit(
      `  ${row.id} ${row.fixture}: ${failures.length === 0 ? "PASS" : `FAIL (${failures.join("; ")})`}`,
    );
    const transcript = yield* Config.String("EV_TRANSCRIPT").pipe(Config.withDefault(""));
    if (transcript !== "") {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(transcript, `${lines.join("\n")}\n`, { flag: "a" });
    }
    return failures;
  }).pipe(Effect.provide(NodeServices.layer));

describe("OpenCode 2 pending-work snapshots (#19228 evidence)", () => {
  it.effect.each(ROWS.map((row) => [`${row.id} ${row.fixture}`, row] as const))("%s", ([, row]) =>
    runRow(row).pipe(
      Effect.map((failures) => assert.deepEqual(failures, [])),
      Effect.scoped,
    ),
  );
});
