/**
 * Wires `AgentTelemetryRecorder` to the provider runtime event stream.
 *
 * Agent spans go only to the OTLP exporter, never the local trace file: they
 * can carry transcript content, and without a collector nobody reads them.
 * With no OTLP traces endpoint configured this layer does nothing.
 *
 * Message and tool content is recorded only when
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`, the standard
 * OpenTelemetry GenAI switch. Without it spans keep names, ids, timing,
 * status, and token counts.
 *
 * @module observability/Layers/AgentTelemetry
 */
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Tracer from "effect/Tracer";

import packageJson from "../../../package.json" with { type: "json" };
import * as ProviderService from "../../provider/Services/ProviderService.ts";
import { AgentTelemetryRecorder } from "../AgentTelemetry.ts";

/** The OTLP trace exporter, when one is configured. Set by `ObservabilityLive`. */
export const AgentTraceExporter = Context.Reference<Tracer.Tracer | undefined>(
  "t3/observability/AgentTraceExporter",
  { defaultValue: () => undefined },
);

export interface AgentTurnInputs {
  /**
   * Records the text T3 is about to hand a provider so the agent span can
   * show it. Call before `sendTurn`, then bind the returned id to the turn.
   */
  readonly noteTurnInput: (input: {
    readonly threadId: string;
    readonly text: string | undefined;
    readonly attachmentCount: number;
    readonly model: string | undefined;
  }) => Effect.Effect<number | undefined>;
  readonly bindTurnInput: (inputId: number | undefined, turnId: string) => Effect.Effect<void>;
  /** Drops a noted send whose `sendTurn` failed. */
  readonly abandonTurnInput: (inputId: number | undefined) => Effect.Effect<void>;
}

/** No-op unless `AgentTelemetryLive` is running. */
export const AgentTurnInputs = Context.Reference<AgentTurnInputs>(
  "t3/observability/AgentTurnInputs",
  {
    defaultValue: () => ({
      noteTurnInput: () => Effect.succeed(undefined),
      bindTurnInput: () => Effect.void,
      abandonTurnInput: () => Effect.void,
    }),
  },
);

class RecorderHolder extends Context.Service<
  RecorderHolder,
  { current: AgentTelemetryRecorder | undefined }
>()("t3/observability/Layers/AgentTelemetry/RecorderHolder") {}

const RecorderHolderLive = Layer.sync(RecorderHolder, () => ({ current: undefined }));

const TurnInputsLive = Layer.effect(
  AgentTurnInputs,
  Effect.gen(function* () {
    const holder = yield* RecorderHolder;
    return {
      noteTurnInput: (input) =>
        // Runtime tracing is disabled in the demo; its spans have "noop" IDs,
        // which are invalid OTLP links. Agent runs start their own trace.
        Effect.sync(() => holder.current?.noteTurnInput({ ...input, link: undefined })),
      bindTurnInput: (inputId, turnId) =>
        Effect.sync(() => {
          if (inputId !== undefined) holder.current?.bindTurnInput(inputId, turnId);
        }),
      abandonTurnInput: (inputId) =>
        Effect.sync(() => {
          if (inputId !== undefined) holder.current?.abandonTurnInput(inputId);
        }),
    } satisfies AgentTurnInputs;
  }),
);

const SubscriberLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const exporter = yield* AgentTraceExporter;
    if (!exporter) return;
    const holder = yield* RecorderHolder;
    const providerService = yield* ProviderService.ProviderService;
    // A bad value must not stop the server; content capture stays off.
    const captureContent = yield* Config.Boolean(
      "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
    ).pipe(
      Config.withDefault(false),
      Effect.catch((cause) =>
        Effect.logWarning(
          "Ignoring invalid OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT; content capture is off.",
          { cause },
        ).pipe(Effect.as(false)),
      ),
    );

    const clock = yield* Clock.Clock;
    const sessionFacts = new Map<string, { model?: string; cwd?: string; instanceId?: string }>();
    const recorder = new AgentTelemetryRecorder({
      tracer: exporter,
      captureContent,
      staticAttributes: {
        "host.name": NodeOS.hostname(),
        "t3.app.version": packageJson.version,
      },
      sessionFacts: (threadId) => sessionFacts.get(threadId),
      nowMs: () => clock.currentTimeMillisUnsafe(),
    });
    holder.current = recorder;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        holder.current = undefined;
        recorder.closeAll("T3 server shut down before the turn finished");
      }),
    );

    yield* providerService.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type === "session.exited") {
            sessionFacts.delete(event.threadId);
          } else if (event.type === "turn.started") {
            // Model and workspace live on the session, not the turn event.
            const sessions = yield* providerService.listSessions();
            const session = sessions.find((entry) => entry.threadId === event.threadId);
            if (session) {
              sessionFacts.set(event.threadId, {
                ...(session.model ? { model: session.model } : {}),
                ...(session.cwd ? { cwd: session.cwd } : {}),
                ...(session.providerInstanceId ? { instanceId: session.providerInstanceId } : {}),
              });
            }
          }
          recorder.handle(event);
          // Telemetry must never end the subscriber or affect the turn.
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.forkScoped,
    );
  }),
);

/** Provides `AgentTurnInputs`; `ProviderService` reads it when constructed. */
export const AgentTurnInputsLive = TurnInputsLive.pipe(Layer.provideMerge(RecorderHolderLive));

/**
 * Records agent runs from provider runtime events when OTLP export is
 * configured. Needs `AgentTurnInputsLive` below it.
 */
export const AgentTelemetryLive = SubscriberLive;
