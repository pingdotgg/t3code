/**
 * Module-level workflow state shared between the Worker layer and the workflow
 * Durable Object instances of the same isolate. Registrations are recorded at
 * Worker init; a running execution provides its own handle through
 * `CurrentExecutionHandle` so engine operations inside the run hit local
 * SQLite instead of a self-RPC.
 *
 * @internal
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Workflow from "effect/workflow/Workflow"
import * as WorkflowEngine from "effect/workflow/WorkflowEngine"
import type { ClusterWorkflowRunOptions, ClusterWorkflowWakeMode } from "../CloudflareDurableObjectPrograms.ts"
import { makeRegistry } from "./registry.ts"

/** @internal */
export interface WorkflowRegistration {
  readonly workflow: Workflow.Any
  readonly execute: (
    payload: object,
    executionId: string
  ) => Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine>
  readonly context: Context.Context<never>
}

const registry = makeRegistry<WorkflowRegistration>()

/** @internal */
export const getWorkflowRegistration: (name: string) => WorkflowRegistration | undefined = registry.get

/** @internal */
export const registerWorkflow: (name: string, registration: WorkflowRegistration) => boolean = registry.register

/** @internal */
export const unregisterWorkflow: (name: string, registration: WorkflowRegistration) => void = registry.unregister

/** @internal */
export type WorkflowRunOptions = ClusterWorkflowRunOptions

/**
 * The transport shared by workflow Durable Object stubs and same-isolate
 * execution handles. All payloads are JSON text.
 *
 * @internal
 */
export interface WorkflowStub {
  readonly run: (payload: string, options: WorkflowRunOptions) => Promise<string>
  readonly poll: () => Promise<string | undefined>
  readonly resume: (mode?: ClusterWorkflowWakeMode) => Promise<void>
  readonly interrupt: () => Promise<void>
  readonly interruptUnsafe: () => Promise<void>
  readonly deferredDone: (name: string, exit: string) => Promise<void>
  readonly scheduleClock: (name: string, deferredName: string, wakeUp: number) => Promise<void>
}

/** @internal */
export interface WorkflowExecutionHandle extends WorkflowStub {
  readonly executionId: string
  readonly loadActivity: (key: string) => string | undefined
  readonly saveActivity: (key: string, exit: string) => void
  readonly loadDeferred: (name: string) => string | undefined
  /** Completes a deferred of this execution from inside its own run. */
  readonly completeOwnDeferred: (name: string, exit: string) => Effect.Effect<void>
}

/**
 * The handle of the workflow execution currently running in this fiber,
 * provided by the workflow Durable Object runtime around each run attempt.
 *
 * @internal
 */
export class CurrentExecutionHandle extends Context.Service<CurrentExecutionHandle, WorkflowExecutionHandle>()(
  "@effect/platform-cloudflare/CloudflareWorkflowEngine/CurrentExecutionHandle"
) {}

/** @internal */
export const deferredState = WorkflowEngine.makeDeferredState()
