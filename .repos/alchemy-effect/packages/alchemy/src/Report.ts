import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { NonInteractiveTerminal } from "./Interaction.ts";
import type { Plan } from "./Plan.ts";
import type { ProviderMode } from "./ProviderMode.ts";

// The engine's reporting contract: the events apply/sync emit while they
// converge a plan, and the session/renderer interfaces a presentation layer
// (the bundled CLI, a custom renderer, tests) implements to observe them.
// Deliberately presentation-free — nothing in here knows about terminals.

export type ApplyStatus =
  | "attaching"
  | "post-attach"
  | "pending"
  | "pre-creating"
  | "creating"
  | "creating replacement"
  | "created"
  | "updating"
  | "updated"
  | "adopting"
  | "adopted"
  | "deleting"
  | "deleted"
  | "orphaning"
  | "orphaned"
  | "replacing"
  | "replaced"
  // Action lifecycle (see {@link Action})
  | "running"
  | "ran"
  | "skipped"
  | "fail";

export type ApplyEvent = ResourceAnnotated | ResourceStatusChanged;

/**
 * How append-only renderers surface a note (the interactive view treats every
 * kind the same): `"status"` is transient spinner text that plain mode folds
 * into the settle line's suffix, `"output"` is verbatim tool output streamed
 * line by line, and `undefined` is a one-shot informational note.
 */
export type NoteKind = "status" | "output";

export interface ResourceAnnotated {
  _tag: "apply.resource.note";
  /** Fully-qualified resource or action name used to target its plan row. */
  fqn: string;
  id: string;
  message: string;
  kind?: NoteKind;
}

export interface ResourceStatusChanged {
  _tag: "apply.resource.status";
  /** Fully-qualified resource or action name used to target its plan row. */
  fqn: string;
  id: string; // resource id (e.g. "messages", "api")
  type: string; // resource type (e.g. "AWS::Lambda::Function", "Cloudflare::Worker")
  status: ApplyStatus;
  message?: string; // optional details
  /**
   * The {@link ProviderMode} this node's provider was resolved for.
   * `undefined` for mode-agnostic providers (a single implementation serves
   * both dev and deploy) and for actions — renderers show nothing special.
   */
  providerMode?: ProviderMode;
  /**
   * Set only on mode-switch replacements (local ⇄ live): the mode the OLD
   * generation was created with, so renderers can annotate the transition
   * (e.g. `local → live`). Always differs from `providerMode` when set.
   */
  fromProviderMode?: ProviderMode;
}

/** One binding row on a planned resource. */
export interface PlannedBinding {
  readonly sid: string;
  readonly action: "create" | "update" | "delete" | "noop";
}

/** Serializable view of one resource row in a plan. */
export interface PlannedResource {
  readonly fqn: string;
  readonly logicalId: string;
  readonly resourceType: string;
  /** The action the plan decided for this resource. */
  readonly action:
    | "create"
    | "update"
    | "adopted"
    | "replace"
    | "delete"
    | "orphaned"
    | "noop";
  /** Binding rows the node carries; empty when the resource has none. */
  readonly bindings: ReadonlyArray<PlannedBinding>;
  /** Mode the node's provider resolved for; absent for mode-agnostic providers. */
  readonly providerMode?: ProviderMode;
  /** On mode-switch replacements: the mode the old generation was created with. */
  readonly fromProviderMode?: ProviderMode;
}

/** Serializable view of one stack-action row in a plan. */
export interface PlannedAction {
  readonly fqn: string;
  readonly logicalId: string;
  readonly actionType: string;
  readonly action: "run" | "delete" | "noop";
}

/**
 * Emitted as a resource's diff begins. Diffs run with unbounded concurrency
 * and may read the cloud (refresh, adoption), so a renderer that only sees
 * completions freezes on the last *finished* node while the slow tail is
 * still working — pairing starts with {@link ResourcePlanned} lets it show
 * what is actually in flight.
 */
export interface ResourceDiffStarted {
  readonly _tag: "plan.resource.started";
  readonly fqn: string;
  readonly logicalId: string;
  readonly resourceType: string;
  readonly total: number;
}

/** Emitted as the planner finishes diffing one resource. */
export interface ResourcePlanned extends PlannedResource {
  readonly _tag: "plan.resource.completed";
  /** How many of `total` resources have been diffed so far. */
  readonly completed: number;
  readonly total: number;
}

/** Emitted as the planner decides one stack action. */
export interface ActionPlanned extends PlannedAction {
  readonly _tag: "plan.action.completed";
  readonly completed: number;
  readonly total: number;
}

/** Phases a stack plan moves through before it is ready. */
export type PlanningPhase =
  | "importing-module"
  | "resolving-services"
  | "loading-state"
  | "computing-plan"
  | "plan-ready";

/**
 * Emitted as the planning pipeline crosses a work boundary, by whoever owns
 * that boundary: the session emits `importing-module`/`resolving-services`
 * around the module import and service build, the engine emits
 * `loading-state` (before the state service resolves — which may bootstrap
 * a remote store — and the persisted rows are read) and `computing-plan`
 * (once diffing begins), and the route emits `plan-ready`. Carries no
 * display text — wording is the renderer's job.
 */
export interface PlanPhaseChanged {
  readonly _tag: "plan.phase";
  readonly phase: PlanningPhase;
}

/** A per-node planning event (one resource or action diffed). */
export type PlanNodeEvent =
  | ResourceDiffStarted
  | ResourcePlanned
  | ActionPlanned;

export type PlanEvent = PlanPhaseChanged | PlanNodeEvent;

/**
 * Emitted around a state-store bootstrap or upgrade (e.g. deploying the
 * Cloudflare state-store worker on first use). Bootstrap happens lazily
 * inside "loading state", can take many seconds, and would otherwise be
 * invisible to renderers and traces.
 */
export interface StateBootstrapStarted {
  readonly _tag: "state.bootstrap.started";
  /** The store being bootstrapped (e.g. the worker script name). */
  readonly store: string;
}

export interface StateBootstrapCompleted {
  readonly _tag: "state.bootstrap.completed";
  readonly store: string;
}

export type StateEvent = StateBootstrapStarted | StateBootstrapCompleted;

export interface NukeScanStarted {
  readonly _tag: "nuke.scan.started";
  readonly total: number;
}

export interface NukeProviderScanStarted {
  readonly _tag: "nuke.scan.provider.started";
  readonly provider: string;
}

export interface NukePassStarted {
  readonly _tag: "nuke.pass.started";
  readonly pass: number;
}

/** Emitted as a nuke scan finishes enumerating one provider's resources. */
export interface NukeProviderScanned {
  readonly _tag: "nuke.scan.provider.completed";
  readonly provider: string;
  /** Resources found for this provider (0 when the listing failed). */
  readonly resources: number;
  /** Listing failure, reported immediately when this provider settles. */
  readonly error?: string;
}

export interface NukeResourceDeleted {
  readonly _tag: "nuke.resource.deleted";
  readonly provider: string;
  /** Display name of the deleted resource. */
  readonly resource: string;
}

/** Emitted when a nuke deletion attempt fails (the run keeps going). */
export interface NukeResourceFailed {
  readonly _tag: "nuke.resource.failed";
  readonly provider: string;
  readonly resource: string;
  readonly message: string;
}

export type NukeEvent =
  | NukeScanStarted
  | NukeProviderScanStarted
  | NukePassStarted
  | NukeProviderScanned
  | NukeResourceDeleted
  | NukeResourceFailed;

export interface ProviderConfigureStarted {
  readonly _tag: "provider.configure.started";
  readonly provider: string;
}

export interface ProviderConfigureCompleted {
  readonly _tag: "provider.configure.completed";
  readonly provider: string;
}

export interface ProviderRefreshStarted {
  readonly _tag: "provider.refresh.started";
  readonly provider: string;
}

export interface ProviderRefreshCompleted {
  readonly _tag: "provider.refresh.completed";
  readonly provider: string;
}

export type ProviderEvent =
  | ProviderConfigureStarted
  | ProviderConfigureCompleted
  | ProviderRefreshStarted
  | ProviderRefreshCompleted;

/**
 * Every progress event the engine and the Alchemist routes can report — one
 * flat union, one `_tag` discriminator, tags namespaced `domain.subject.verb`.
 */
export type ProgressEvent =
  | PlanEvent
  | ApplyEvent
  | StateEvent
  | NukeEvent
  | ProviderEvent;

export type ProgressReporter = (event: ProgressEvent) => Effect.Effect<void>;

/**
 * The one ambient progress channel. Everything long-running — the planner's
 * phase/node events, state-store bootstrap, nuke scans and deletions,
 * provider configure/refresh — reports through it. Defaults to a no-op, so
 * a caller that only wants the result provides nothing; a renderer provides
 * its own handler for the events it wants to observe.
 */
export const Progress = Context.Reference<ProgressReporter>(
  "alchemy/Progress",
  { defaultValue: (): ProgressReporter => () => Effect.void },
);

export interface PlanStatusSession {
  emit: (event: ApplyEvent) => Effect.Effect<void>;
  done: (outcome: "success" | "failure") => Effect.Effect<void>;
  /** Replace the dev widget's stack output view without writing scrollback. */
  setOutput?: (value: unknown) => Effect.Effect<void>;
  /**
   * Tear down the session's live presentation without settling it. Dev keeps
   * its widget mounted after `done`; an interrupted generation (reload,
   * Ctrl+C) must remove it so the next generation does not stack another.
   */
  close?: Effect.Effect<void>;
}

/** A session that drops everything — the default when no renderer is ambient. */
export const noopSession: PlanStatusSession = {
  emit: () => Effect.void,
  done: () => Effect.void,
};

export interface PlanningStatusSession {
  update: (
    label: string,
    detail?: string,
    options?: {
      /**
       * Animate the status glyph. Pass `false` for phases whose work runs
       * synchronously on the main thread (e.g. module import) — a spinner
       * cannot animate while the event loop is blocked, so it freezes
       * mid-frame and reads as hung; a static row doesn't promise motion.
       */
      readonly spinning?: boolean;
    },
  ) => Effect.Effect<void>;
  succeed: (message?: string) => Effect.Effect<void>;
  fail: (message?: string) => Effect.Effect<void>;
  close: Effect.Effect<void>;
}

export interface ScopedPlanStatusSession extends PlanStatusSession {
  note: (
    note: string,
    options?: { readonly kind?: NoteKind },
  ) => Effect.Effect<void>;
}

export interface PlanDisplayOptions {
  /** Show declared resource inputs as structured YAML. */
  detailed?: boolean;
  /** Stage displayed in terminal lifecycle updates. */
  stage?: string;
  /** Keep the dev plan mounted as a collapsible widget below static logs. */
  dev?: boolean;
}

export interface CLIService {
  startPlanningSession: (
    label: string,
    detail?: string,
    title?: string,
  ) => Effect.Effect<PlanningStatusSession>;
  approvePlan: <P extends Plan>(
    plan: P,
    options?: PlanDisplayOptions,
  ) => Effect.Effect<boolean, NonInteractiveTerminal>;
  displayPlan: <P extends Plan>(
    plan: P,
    options?: PlanDisplayOptions,
  ) => Effect.Effect<void>;
  startApplySession: <P extends Plan>(
    plan: P,
    options?: PlanDisplayOptions,
  ) => Effect.Effect<PlanStatusSession>;
}

export class Cli extends Context.Service<Cli, CLIService>()("CLI") {}
