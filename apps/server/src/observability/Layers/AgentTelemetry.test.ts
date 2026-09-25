import { assert, it } from "@effect/vitest";
import { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import * as ProviderService from "../../provider/Services/ProviderService.ts";
import {
  AgentTelemetryLive,
  AgentTraceExporter,
  AgentTurnInputs,
  AgentTurnInputsLive,
} from "./AgentTelemetry.ts";

const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

it.effect("completes an agent run without linking to disabled background spans", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const drained = yield* Deferred.make<void>();
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const telemetry = AgentTelemetryLive.pipe(
      Layer.provideMerge(AgentTurnInputsLive),
      Layer.provide(Layer.succeed(AgentTraceExporter, tracer)),
      Layer.provide(
        Layer.mock(ProviderService.ProviderService)({
          listSessions: () => Effect.succeed([]),
          streamEvents: Stream.fromQueue(events).pipe(
            Stream.take(2),
            Stream.ensuring(Deferred.succeed(drained, undefined)),
          ),
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const inputs = yield* AgentTurnInputs;
      const inputId = yield* inputs
        .noteTurnInput({
          threadId: "demo-thread",
          text: "Read git status",
          attachmentCount: 0,
          model: "demo-model",
        })
        .pipe(Effect.withSpan("ProviderService.sendTurn"));
      yield* inputs.bindTurnInput(inputId, "demo-turn");
      for (const type of ["turn.started", "turn.completed"] as const) {
        yield* Queue.offer(
          events,
          decodeEvent({
            eventId: type,
            provider: "codex",
            threadId: "demo-thread",
            turnId: "demo-turn",
            createdAt: "2026-09-24T22:00:00.000Z",
            type,
            payload: type === "turn.completed" ? { state: "completed" } : {},
          }),
        );
      }
      yield* Deferred.await(drained);
    }).pipe(Effect.provide(telemetry), Effect.provideService(References.TracerEnabled, false));

    const run = spans.find((span) => span.attributes.get("logfire.span_type") !== "pending_span");
    assert.isDefined(run);
    assert.equal(run?.name, "invoke_agent T3 Code / Codex");
    assert.equal(run?.status._tag, "Ended");
    assert.deepEqual(run?.links, []);
  }),
);
