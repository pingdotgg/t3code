import * as Schema from "effect/Schema";

import type { MessageBroker } from "./t3work-sdk.broker.ts";
import type { AnyRecipeRef } from "./t3work-sdk.recipeTypes.ts";

export type {
  AnyRecipeRef,
  RecipeApplicabilitySpec,
  RecipeBrevity,
  RecipeDetailDensity,
  RecipeGuidanceStyle,
  RecipeRef,
  RecipeTechnicalDepth,
} from "./t3work-sdk.recipeTypes.ts";
export type {
  PrimitiveCall,
  PrimitiveKind,
  WorkflowRuntime,
} from "./t3work-sdk.runtimeTypes.ts";

export type EngineCapability = "thread" | "child" | "user" | "script" | "ui" | "workflow";
export type IntegrationMethod = (...args: ReadonlyArray<unknown>) => Promise<unknown>;

export interface IntegrationClient {
  readonly [key: string]: IntegrationClient | IntegrationMethod;
}

export interface FetchLike {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface ToolLogger {
  readonly info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly warn: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly error: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export interface ToolWorkspace {
  readonly readText: (relativePath: string) => Promise<string>;
  readonly writeText: (relativePath: string, content: string) => Promise<void>;
  readonly exists: (relativePath: string) => Promise<boolean>;
}

export interface T3workToolHandlerClient {
  readonly renameThread: (input: { readonly title: string }) => Promise<{
    readonly ok: true;
    readonly title: string;
    readonly threadId?: string | undefined;
  }>;
}

export interface ToolGroupRef<Id extends string = string> {
  readonly kind: "tool-group";
  readonly id: Id;
  readonly label: string;
  readonly description: string;
}

export type WorkflowCapability = EngineCapability | ToolGroupRef;

export interface ModelRef<Id extends string = string, Provider extends string = string> {
  readonly kind: "model";
  readonly id: Id;
  readonly provider: Provider;
}

/** A per-call model choice: a project-configured provider-instance id + a typed `ModelRef`. */
export interface ModelSelection {
  readonly provider: string;
  readonly model: ModelRef;
}

export interface WorkflowRef<Inputs = unknown, Outputs = unknown, Path extends string = string> {
  readonly kind: "workflow";
  readonly path: Path;
  readonly absolutePath: string;
  readonly Inputs?: Inputs;
  readonly Outputs?: Outputs;
}

export interface ToolHandlerCtx {
  readonly threadId?: string;
  readonly runId?: string;
  readonly workspaceRoot: string;
  readonly log: ToolLogger;
  readonly fetch: FetchLike;
  readonly workspace: ToolWorkspace;
  /** Call another tool from inside a handler. A **black box**: the nested call is NOT journaled
   * and consumes no `seq` (the enclosing primitive is the journaled checkpoint). */
  readonly callTool: <I, R>(ref: ToolRef<I, R>, args: I) => Promise<R>;
  readonly github?: IntegrationClient;
  readonly jira?: IntegrationClient;
  readonly t3work?: T3workToolHandlerClient;
}

export interface ScriptHandlerCtx {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly log: ToolLogger;
  readonly fetch: FetchLike;
  readonly workspace: ToolWorkspace;
  readonly callTool: <I, R>(ref: ToolRef<I, R>, args: I) => Promise<R>;
}

export interface ToolRef<
  I,
  R,
  Id extends string = string,
  Group extends ToolGroupRef = ToolGroupRef,
> {
  (args: I): Promise<R>;
  readonly kind: "tool";
  readonly id: Id;
  readonly group: Group;
  readonly args: Schema.Schema<I>;
  readonly result: Schema.Schema<R>;
  readonly handler: (args: I, ctx: ToolHandlerCtx) => Promise<R>;
}

export interface ScriptRef<I, O> {
  (args: I): Promise<O>;
  readonly kind: "script";
  readonly replay: "default" | "never";
  readonly inputs: Schema.Schema<I>;
  readonly outputs: Schema.Schema<O>;
  readonly handler: (args: I, ctx: ScriptHandlerCtx) => Promise<O>;
}

export interface RegisteredWorkflowToolsTree {}
export interface RegisteredWorkflowScriptsTree {}

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer I) => void ? I : never;
type SnakeToCamelCase<Value extends string> = Value extends `${infer Head}_${infer Tail}` ? `${Head}${Capitalize<SnakeToCamelCase<Tail>>}` : Value;
type DotPathTree<Path extends string, Value> = Path extends `${infer Head}.${infer Tail}` ? { [K in SnakeToCamelCase<Head>]: DotPathTree<Tail, Value> } : { [K in SnakeToCamelCase<Path>]: Value };

export type ToolTreeFromRefs<TRefs extends readonly unknown[]> = [TRefs[number]] extends [never] ? {} : Simplify<
    UnionToIntersection<TRefs[number] extends infer TRef ? TRef extends { readonly id: infer Id extends string } ? DotPathTree<Id, TRef> : never : never>
  >;

export type ScriptTreeFromRecord<TScripts extends Record<string, AnyScriptRef>> = {
  readonly [K in keyof TScripts]: TScripts[K];
};

export type WorkflowInputs<TModule> = TModule extends { Inputs: Schema.Schema<infer V> } ? V : unknown;
export type WorkflowOutputs<TModule> = TModule extends { Outputs: Schema.Schema<infer V> } ? V : unknown;

export type AnyToolGroupRef = ToolGroupRef<string>;
export type AnyToolRef = ToolRef<unknown, unknown, string, AnyToolGroupRef>;
export type AnyScriptRef = ScriptRef<unknown, unknown>;

export type WorkflowSdkRegistry = {
  readonly toolGroups: Map<string, AnyToolGroupRef>;
  readonly tools: Map<string, AnyToolRef>;
  readonly recipes: Map<string, AnyRecipeRef>;
};

/** Options shared by `startWorkflow` and `resumeWorkflow`. Re-exported from engine. */
export interface WorkflowRunOptions {
  readonly runsRoot?: string;
  // Durable journal storage (default fs at `runsRoot`); host injects SQLite for restart durability (§OQ2).
  readonly store?: import("./t3work-sdk.journalStore.ts").JournalStore;
  readonly tools?: ReadonlyArray<AnyToolRef>;
  readonly scripts?: Readonly<Record<string, AnyScriptRef>>;
  readonly fetch?: FetchLike;
  readonly workspace?: ToolWorkspace;
  readonly log?: ToolLogger;
  readonly workspaceRoot?: string;
  // `budget` is the body's `budget.total`; `onPhase`/`onLog` are cosmetic progress callbacks.
  readonly budget?: number;
  readonly onPhase?: (title: string) => void;
  readonly onLog?: (message: string) => void;
  // Thread-model wiring: thread verbs fire through `broker` into the host. `launchThreadId` is
  // the chat the user launched from (the `thread` global binds to it; absent → headless).
  // `defaultModel` backs agent/askAgent calls that omit a per-call model.
  readonly broker?: MessageBroker;
  readonly launchThreadId?: string;
  readonly defaultModel?: ModelSelection;
}
