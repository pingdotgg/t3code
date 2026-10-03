import { lazy, type ComponentType } from "react";

export interface PanelDefinition<Props, Id extends string = string> {
  id: Id;
  title: string;
  placement: "side-panel";
  load: () => Promise<{ default: ComponentType<Props> }>;
}

// Registration only creates lazy component identities. Reads and workers belong to mounts.
export function createPanelRegistry<Props, Id extends string = string>(
  definitions: readonly PanelDefinition<Props, Id>[],
) {
  const panels = new Map<Id, PanelDefinition<Props, Id> & { Component: ComponentType<Props> }>();
  for (const definition of definitions) {
    if (panels.has(definition.id)) throw new Error(`Duplicate panel id: ${definition.id}`);
    panels.set(definition.id, { ...definition, Component: lazy(definition.load) });
  }
  return { get: (id: Id) => panels.get(id) };
}
