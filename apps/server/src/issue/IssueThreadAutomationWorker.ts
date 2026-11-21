import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IssueThreadAutomationService from "./IssueThreadAutomationService.ts";

const SWEEP_INTERVAL_MS = 60_000;

/** Sweeps issue statuses once a minute while the server runs, with or without clients. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const service = yield* IssueThreadAutomationService.IssueThreadAutomationService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    let dueAt = 0;
    // A saved rule or a newly linked issue is read on the next tick, not a minute later.
    yield* forkParked(
      Stream.runForEach(settings.streamChanges, () =>
        Effect.sync(() => {
          dueAt = 0;
        }),
      ),
    );
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        Effect.sync(() => {
          if (event.type === "thread.issue-synced") dueAt = 0;
        }),
      ),
    );
    yield* scheduler.register(
      "issue-thread-automation",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now < dueAt) return;
        dueAt = now + SWEEP_INTERVAL_MS;
        yield* service.sweep;
      }),
    );
  }),
);
