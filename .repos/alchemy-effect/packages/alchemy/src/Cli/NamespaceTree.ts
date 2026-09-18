import { toPath } from "../FQN.ts";
import type {
  BindingAction,
  CRUD,
  ActionApply,
  ActionDelete,
  Plan,
} from "../Plan.ts";
import type { ProviderMode } from "../ProviderMode.ts";
import {
  formatDeclaredPropertyYaml,
  formatDriftPropertyYaml,
  type DeclaredPropertyYaml,
} from "./PropertyDiff.ts";

export type ActionTreeItem = ActionApply | ActionDelete;
export type ActionVerb = ActionTreeItem["action"]; // "run" | "noop" | "delete"

/** No-op actions are dependency markers, not work the user needs to review. */
export const actionHasPlannedWork = (item: ActionTreeItem): boolean =>
  item.action !== "noop";

export interface PlanSummaryCounts {
  readonly counts: Record<
    | "create"
    | "update"
    | "adopted"
    | "delete"
    | "orphaned"
    | "replace"
    | "noop",
    number
  >;
  readonly taskCounts: Record<"run" | "delete" | "noop", number>;
  readonly bindingChanges: number;
}

/** Count every resource and task, plus binding changes, for the Plan summary. */
export const buildPlanSummary = (plan: Plan): PlanSummaryCounts => {
  const allItems = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions),
  ].filter((item): item is CRUD => item !== undefined);
  const counts = {
    create: 0,
    update: 0,
    adopted: 0,
    delete: 0,
    orphaned: 0,
    noop: 0,
    replace: 0,
  };
  for (const item of allItems) {
    counts[item.action]++;
  }
  const taskCounts = { run: 0, noop: 0, delete: 0 };
  for (const item of [
    ...Object.values(plan.actions ?? {}),
    ...Object.values(plan.actionDeletions ?? {}),
  ].filter((task): task is ActionTreeItem => task !== undefined)) {
    taskCounts[item.action]++;
  }
  const bindingChanges = allItems.reduce(
    (count, item) =>
      count +
      item.bindings.filter((binding) => binding.action !== "noop").length,
    0,
  );
  return { counts, taskCounts, bindingChanges };
};

/**
 * A tree node representing a namespace.
 * Resources and tasks live directly inside the namespace where they were
 * created.
 */
export interface TreeNode {
  id: string;
  path: string[];
  children: Map<string, TreeNode>;
  resources: CRUD[];
  actions: ActionTreeItem[];
}

export type DerivedAction =
  | "create"
  | "update"
  | "adopted"
  | "delete"
  | "orphaned"
  | "replace"
  | "noop"
  | "mixed";

export function buildNamespaceTree(
  items: CRUD[],
  actions: ReadonlyArray<ActionTreeItem> = [],
): TreeNode {
  const root: TreeNode = {
    id: "",
    path: [],
    children: new Map(),
    resources: [],
    actions: [],
  };

  const getNode = (path: string[]) => {
    let current = root;
    for (let i = 0; i < path.length; i++) {
      const segment = path[i];
      let child = current.children.get(segment);
      if (!child) {
        child = {
          id: segment,
          path: path.slice(0, i + 1),
          children: new Map(),
          resources: [],
          actions: [],
        };
        current.children.set(segment, child);
      }
      current = child;
    }
    return current;
  };

  for (const item of items) {
    getNode(toPath(item.resource.Namespace)).resources.push(item);
  }
  for (const action of actions) {
    getNode(toPath(action.def.Namespace)).actions.push(action);
  }

  return root;
}

function deriveNamespaceAction(node: TreeNode): DerivedAction {
  const actions = new Set<BindingAction | CRUD["action"] | DerivedAction>();

  for (const resource of node.resources) {
    actions.add(deriveResourceChildrenAction(resource, node));
  }
  for (const action of node.actions) {
    // Map task actions onto the resource action space for the rollup:
    // run → create, delete → delete, noop → noop.
    actions.add(
      action.action === "run"
        ? "create"
        : action.action === "delete"
          ? "delete"
          : "noop",
    );
  }
  for (const child of node.children.values()) {
    const childAction = deriveNamespaceAction(child);
    if (childAction === "mixed") {
      return "mixed";
    }
    actions.add(childAction);
  }

  return deriveAction(actions);
}

export interface FlattenedItem {
  type: "namespace" | "resource" | "binding" | "action";
  depth: number;
  id: string;
  path: string[];
  action: CRUD["action"] | BindingAction | DerivedAction | ActionVerb;
  resourceType?: string;
  bindingSid?: string;
  bindingCount?: number;
  hasChildren?: boolean;
  /** For task items, the Task's Type (e.g. "Sync"). */
  actionType?: string;
  /**
   * For resource items, the {@link ProviderMode} the node's provider was
   * resolved for. `undefined` for mode-agnostic providers.
   */
  providerMode?: ProviderMode;
  /**
   * For resource items planned as a mode-switch replacement, the mode the
   * old generation was created with (always differs from `providerMode`).
   */
  fromProviderMode?: ProviderMode;
  /** Safe YAML detail attached only when the caller opts into detailed view. */
  propertyYaml?: DeclaredPropertyYaml;
}

export interface FlattenTreeOptions {
  includePropertyYaml?: boolean;
}

export function flattenTree(
  node: TreeNode,
  options: FlattenTreeOptions = {},
): FlattenedItem[] {
  const result: FlattenedItem[] = [];
  flattenNamespace(node, 0, result, options);
  return result;
}

const flattenNamespace = (
  node: TreeNode,
  depth: number,
  result: FlattenedItem[],
  options: FlattenTreeOptions,
) => {
  const sortedResources = [...node.resources].sort((a, b) =>
    a.resource.LogicalId.localeCompare(b.resource.LogicalId),
  );
  const sortedChildren = Array.from(node.children.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const resourceIds = new Set(
    sortedResources.map((resource) => resource.resource.LogicalId),
  );

  for (const [id, child] of sortedChildren) {
    if (resourceIds.has(id) || isEmpty(child)) {
      continue;
    }
    result.push({
      type: "namespace",
      depth,
      id,
      path: child.path,
      action: deriveNamespaceAction(child),
      hasChildren: true,
    });
    flattenNamespace(child, depth + 1, result, options);
  }

  for (const resource of sortedResources) {
    const childNamespace = node.children.get(resource.resource.LogicalId);
    result.push({
      type: "resource",
      depth,
      id: resource.resource.LogicalId,
      path: [...node.path, resource.resource.LogicalId],
      action: resource.action,
      resourceType: resource.resource.Type,
      bindingCount: resource.bindings.length,
      providerMode: resource.mode,
      fromProviderMode:
        resource.action === "replace" &&
        resource.mode !== undefined &&
        resource.state.providerMode !== undefined &&
        resource.state.providerMode !== resource.mode
          ? resource.state.providerMode
          : undefined,
      propertyYaml:
        "drift" in resource && resource.drift !== undefined
          ? formatDriftPropertyYaml(
              resource.drift.expected,
              resource.drift.actual,
              resource.drift.missing,
            )
          : options.includePropertyYaml &&
              (resource.action === "create" ||
                resource.action === "update" ||
                resource.action === "adopted" ||
                resource.action === "replace")
            ? formatDeclaredPropertyYaml(
                resource.action === "create" ? {} : resource.state.props,
                resource.props,
                resource.action === "adopted" ? "update" : resource.action,
              )
            : undefined,
    });
    for (const binding of [...resource.bindings].sort((a, b) =>
      a.sid.localeCompare(b.sid),
    )) {
      result.push({
        type: "binding",
        depth: depth + 1,
        id: binding.sid,
        path: [...node.path, resource.resource.LogicalId, binding.sid],
        action: binding.action,
        bindingSid: binding.sid,
      });
    }
    if (childNamespace) {
      flattenNamespace(childNamespace, depth + 1, result, options);
    }
  }

  // Actions are listed after resources at the same depth.
  const sortedActions = [...node.actions].sort((a, b) =>
    a.def.LogicalId.localeCompare(b.def.LogicalId),
  );
  for (const action of sortedActions) {
    result.push({
      type: "action",
      depth,
      id: action.def.LogicalId,
      path: [...node.path, action.def.LogicalId],
      action: action.action,
      actionType: action.def.Type,
    });
  }
};

const isEmpty = (node: TreeNode) =>
  node.resources.length === 0 &&
  node.actions.length === 0 &&
  Array.from(node.children.values()).every(isEmpty);

const deriveResourceChildrenAction = (
  resource: CRUD,
  node: TreeNode,
): DerivedAction => {
  const actions = new Set<BindingAction | CRUD["action"] | DerivedAction>([
    resource.action,
  ]);
  for (const binding of resource.bindings) {
    actions.add(binding.action);
  }
  const childNamespace = node.children.get(resource.resource.LogicalId);
  if (childNamespace) {
    actions.add(deriveNamespaceAction(childNamespace));
  }
  return deriveAction(actions);
};

const deriveAction = (
  actions: Set<BindingAction | CRUD["action"] | DerivedAction>,
): DerivedAction => {
  if (actions.size === 0) return "noop";
  if (actions.has("replace")) return actions.size === 1 ? "replace" : "mixed";
  if (actions.has("orphaned")) return actions.size === 1 ? "orphaned" : "mixed";
  if (actions.has("delete")) return actions.size === 1 ? "delete" : "mixed";
  if (actions.has("create")) return actions.size === 1 ? "create" : "mixed";
  if (actions.has("adopted")) return actions.size === 1 ? "adopted" : "mixed";
  if (actions.has("update")) return actions.size === 1 ? "update" : "mixed";
  return "noop";
};
