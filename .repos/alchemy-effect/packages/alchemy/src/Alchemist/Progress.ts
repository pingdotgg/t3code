import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { PlanStatusSession, ProgressEvent } from "../Report.ts";
import { type ProgressReporter } from "../Report.ts";

// The event contract itself lives in Report.ts (one flat `_tag` union, the
// `Progress` reference the engine emits into). This module adds the
// Alchemist-side plumbing: the OTEL span-event bridge routes wrap their
// reporter with, and the adapter to the engine's apply-session contract.
export {
  Progress,
  type ActionPlanned,
  type ApplyEvent,
  type NukeEvent,
  type NukeScanStarted,
  type NukeProviderScanStarted,
  type NukePassStarted,
  type NukeProviderScanned,
  type NukeResourceDeleted,
  type NukeResourceFailed,
  type PlanEvent,
  type PlanNodeEvent,
  type PlanPhaseChanged,
  type PlanningPhase,
  type ProgressEvent,
  type ProgressReporter,
  type ProviderConfigureCompleted,
  type ProviderConfigureStarted,
  type ProviderEvent,
  type ProviderRefreshCompleted,
  type ProviderRefreshStarted,
  type ResourceAnnotated,
  type ResourceDiffStarted,
  type ResourcePlanned,
  type ResourceStatusChanged,
  type StateBootstrapCompleted,
  type StateBootstrapStarted,
  type StateEvent,
} from "../Report.ts";

/**
 * The OTEL span-event shape of one {@link ProgressEvent}, or `undefined`
 * for events that are renderer-only. Per-node plan events are deliberately
 * excluded: a plan emits one per resource *including noops* on every
 * (re)plan — dev-watch replans would flood the collector with rows that
 * mostly say "noop", and the node's own `plan.diff.resource` span already
 * carries the diff. The phase markers are enough to know planning started
 * and where the time went.
 */
const spanEventOf = (
  event: ProgressEvent,
): { name: string; attributes: Record<string, unknown> } | undefined => {
  switch (event._tag) {
    case "plan.phase":
      return {
        name: "alchemy.plan.phase",
        attributes: { "alchemy.plan.phase": event.phase },
      };
    case "plan.resource.started":
    case "plan.resource.completed":
    case "plan.action.completed":
      return undefined;
    case "apply.resource.status":
      return {
        name: "alchemy.apply.resource.status",
        attributes: {
          "alchemy.resource.fqn": event.fqn,
          "alchemy.resource.logical_id": event.id,
          "alchemy.resource.type": event.type,
          "alchemy.apply.resource.status": event.status,
          ...(event.message === undefined
            ? {}
            : { "alchemy.apply.message": event.message }),
        },
      };
    case "apply.resource.note":
      return {
        name: "alchemy.apply.resource.note",
        attributes: {
          "alchemy.resource.fqn": event.fqn,
          "alchemy.resource.logical_id": event.id,
          "alchemy.apply.message": event.message,
          ...(event.kind === undefined
            ? {}
            : { "alchemy.apply.note.kind": event.kind }),
        },
      };
    case "state.bootstrap.started":
    case "state.bootstrap.completed":
      return {
        name: `alchemy.${event._tag}`,
        attributes: { "alchemy.state_store.name": event.store },
      };
    case "nuke.scan.started":
      return {
        name: "alchemy.nuke.scan.started",
        attributes: { "alchemy.nuke.providers": event.total },
      };
    case "nuke.pass.started":
      return {
        name: "alchemy.nuke.pass.started",
        attributes: { "alchemy.nuke.pass": event.pass },
      };
    case "nuke.scan.provider.started":
      return {
        name: "alchemy.nuke.scan.provider.started",
        attributes: { "alchemy.provider": event.provider },
      };
    case "nuke.scan.provider.completed":
      return {
        name: "alchemy.nuke.scan.provider.completed",
        attributes: {
          "alchemy.provider": event.provider,
          "alchemy.nuke.resources": event.resources,
          ...(event.error === undefined
            ? {}
            : { "alchemy.nuke.message": event.error }),
        },
      };
    case "nuke.resource.deleted":
      return {
        name: "alchemy.nuke.resource.deleted",
        attributes: { "alchemy.resource.display_name": event.resource },
      };
    case "nuke.resource.failed":
      return {
        name: "alchemy.nuke.resource.failed",
        attributes: {
          "alchemy.resource.display_name": event.resource,
          "alchemy.nuke.message": event.message,
        },
      };
    case "provider.configure.started":
    case "provider.configure.completed":
    case "provider.refresh.started":
    case "provider.refresh.completed":
      return {
        name: `alchemy.${event._tag}`,
        attributes: { "alchemy.provider": event.provider },
      };
  }
};

/**
 * Decorate a reporter so a {@link ProgressEvent} with a span-event shape is
 * also recorded on the currently active span before it reaches the
 * renderer. Emission happens inside the engine's instrumented fibers, so
 * apply events land on `apply.resource` / `provider.<op>` spans — giving
 * traces a within-span timeline of status transitions. A no-op when no
 * span is active (tracing disabled), and independent of whether a renderer
 * is attached, so `--yes` and CI runs still produce the events.
 */
export const withSpanEvents =
  (report: ProgressReporter): ProgressReporter =>
  (event) => {
    const spanEvent = spanEventOf(event);
    if (spanEvent === undefined) return report(event);
    return Effect.currentSpan.pipe(
      Effect.flatMap((span) =>
        Effect.flatMap(Clock.currentTimeNanos, (now) =>
          Effect.sync(() =>
            span.event(spanEvent.name, now, spanEvent.attributes),
          ),
        ),
      ),
      Effect.ignore,
      Effect.andThen(report(event)),
    );
  };

/** Adapt the ambient reporter to the engine's apply-session contract. */
export const applySession = (report: ProgressReporter): PlanStatusSession => ({
  emit: (event) => report(event),
  done: () => Effect.void,
});
