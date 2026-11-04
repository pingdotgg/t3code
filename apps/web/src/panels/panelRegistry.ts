import { lazy, type ComponentType, type ReactNode } from "react";

/** Panel bodies are function components; their props are inferred per id. */
type PanelBody = (props: never) => ReactNode;

export interface PanelDefinition<Id extends string, Body extends PanelBody> {
  id: Id;
  /** Launcher label and tab title fallback. */
  title: string;
  icon: ComponentType<{ className?: string }>;
  /** Letter that opens the panel from the empty launcher and the add menu. */
  launcherKey: string;
  /** Whether this client can show the panel at all, such as desktop-only panels on web. */
  isSupported?: () => boolean;
  /** One-line reason shown in the empty launcher while unavailable. */
  unavailableHint: string;
  /** Full reason shown in the add menu tooltip while unavailable. */
  unavailableReason: string;
  /** Shown while the body's code loads; null when the panel has nothing lighter to show. */
  fallback?: ReactNode;
  load: () => Promise<{ default: Body }>;
}

type AnyPanelDefinition = PanelDefinition<string, PanelBody>;

/** Everything a launcher or tab may read about a panel without loading it. */
export type PanelMetadata = Omit<AnyPanelDefinition, "load">;

/** Props of the body a definition lazily loads, inferred from its `load` import. */
export type PanelProps<Definition extends AnyPanelDefinition> = Awaited<
  ReturnType<Definition["load"]>
>["default"] extends (props: infer Props) => ReactNode
  ? Props
  : never;

// Distributes, so a widened id yields a union of bodies rather than a body accepting either props.
type RegisteredPanel<Definition extends AnyPanelDefinition> = Definition extends AnyPanelDefinition
  ? Definition & { Component: ComponentType<PanelProps<Definition>> }
  : never;

// Registration only creates lazy component identities. Reads and workers belong to mounts.
export function createPanelRegistry<const Definition extends AnyPanelDefinition>(
  definitions: readonly Definition[],
) {
  const panels = new Map<string, Definition & { Component: ComponentType<never> }>();
  for (const definition of definitions) {
    if (panels.has(definition.id)) throw new Error(`Duplicate panel id: ${definition.id}`);
    const load = definition.load as () => Promise<{ default: ComponentType<object> }>;
    panels.set(definition.id, { ...definition, Component: lazy(load) });
  }
  return {
    definitions,
    // lazy() erases the per-id props; get() restores them from the definition's id.
    get: <Id extends Definition["id"]>(id: Id) => {
      const panel = panels.get(id);
      if (!panel) throw new Error(`Unknown panel id: ${id}`);
      return panel as RegisteredPanel<Extract<Definition, { id: Id }>>;
    },
  };
}
