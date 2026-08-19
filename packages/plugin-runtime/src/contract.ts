export type ContributionData =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<ContributionData>
  | { readonly [key: string]: ContributionData };

export interface Contribution<Data extends ContributionData = ContributionData> {
  readonly id: string;
  readonly label: string;
  readonly data?: Data;
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
  readonly register: {
    (slot: string, contribution: Contribution): void;
    <Value>(slot: string, contribution: Contribution, value: Value): void;
  };
  readonly onDispose: (finalizer: () => void | Promise<void>) => void;
}

export interface PluginRuntimeContributionSnapshot {
  readonly generation: number;
  readonly entries: ReadonlyArray<Contribution>;
}

export interface PluginRuntimeSnapshot {
  readonly active: ReadonlyArray<string>;
  readonly blocked: Readonly<Partial<Record<string, string>>>;
  readonly contributions: Readonly<Partial<Record<string, ReadonlyArray<Contribution>>>>;
}

export interface PluginRuntimeOptions {
  readonly validateSnapshot?: (snapshot: PluginRuntimeSnapshot) => void;
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
