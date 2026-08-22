export interface Contribution {
  readonly id: string;
  readonly label: string;
}

export interface PluginDefinition {
  readonly id: string;
  readonly version: string;
  readonly requires?: ReadonlyArray<string>;
  readonly provides?: Readonly<Record<string, unknown>>;
  readonly activate: (context: PluginActivationContext) => void | Promise<void>;
}

export interface PluginActivationContext {
  readonly resolve: <Service>(capability: string) => Service;
  readonly register: (slot: string, contribution: Contribution) => void;
  readonly onDispose: (finalizer: () => void | Promise<void>) => void;
}

export interface PluginRuntimeSnapshot {
  readonly active: ReadonlyArray<string>;
  readonly blocked: Readonly<Partial<Record<string, string>>>;
  readonly contributions: Readonly<Partial<Record<string, ReadonlyArray<Contribution>>>>;
}

export interface PluginRuntime {
  readonly reconcile: (
    definitions: ReadonlyArray<PluginDefinition>,
  ) => Promise<PluginRuntimeSnapshot>;
  readonly snapshot: () => PluginRuntimeSnapshot;
  readonly dispose: () => Promise<void>;
}

export interface PluginRuntimeOptions {
  readonly onLifecycle?: (event: {
    readonly phase: "activate" | "deactivate";
    readonly pluginId: string;
  }) => void;
  readonly onLifecycleError?: (event: {
    readonly phase: "activate" | "deactivate";
    readonly pluginId: string;
    readonly error: unknown;
  }) => void;
  readonly onCleanupError?: (event: {
    readonly phase: "retire" | "rollback";
    readonly error: unknown;
  }) => void;
}

export type PluginRuntimeFactory = (options?: PluginRuntimeOptions) => PluginRuntime;
