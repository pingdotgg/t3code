import type { ActionApply, ActionDelete, CRUD, Plan } from "../../../Plan.ts";
import type {
  ApplyEvent,
  ApplyStatus,
  ResourceStatusChanged,
} from "../../../Report.ts";
import type { ProviderMode } from "../../../ProviderMode.ts";
import {
  buildNamespaceTree,
  buildPlanSummary,
  flattenTree,
  type ActionVerb,
  type FlattenedItem,
  type PlanSummaryCounts,
} from "../../NamespaceTree.ts";
import type { DeclaredPropertyYaml } from "../../PropertyDiff.ts";
import { isInProgress, isTerminalStatus } from "./statusStyle.ts";

export type PlanRow =
  | {
      key: string;
      type: "namespace";
      id: string;
      depth: number;
      action: FlattenedItem["action"];
    }
  | {
      key: string;
      type: "resource";
      id: string;
      resourceType: string;
      /** Secondary identity for inventories without logical resource names. */
      detail?: string;
      depth: number;
      action: CRUD["action"];
      persistedApplyStatus?: "created" | "updated";
      providerMode?: ProviderMode;
      fromProviderMode?: ProviderMode;
      propertyYaml?: DeclaredPropertyYaml;
    }
  | {
      key: string;
      type: "binding";
      id: string;
      depth: number;
      action: "create" | "update" | "delete" | "noop";
      /**
       * Row key of the resource that carries this binding. Bindings have no
       * lifecycle of their own — the host provider reconciles them — so the
       * row mirrors the host's apply status instead of tracking its own.
       */
      hostKey: string;
    }
  | {
      key: string;
      type: "task";
      id: string;
      depth: number;
      action: ActionVerb;
    };

export type ResourceRow = Extract<PlanRow, { type: "resource" }>;

/**
 * Only resources and actions receive apply events and settle. Namespaces are
 * grouping only, and bindings are reconciled by their host resource, so
 * counting them would leave the progress total unreachable.
 */
const isProgressRow = (row: PlanRow) =>
  row.type === "resource" || row.type === "task";

export interface RowState extends Required<
  Pick<ResourceStatusChanged, "id" | "status">
> {
  key: string;
  message?: string;
  startedAt?: number;
  elapsedMs?: number;
}

export type PlanViewport = "full" | "virtual";
export type PlanView = "plan" | "output";
export type PlanOutcome = "success" | "failure";

export interface PlanProgress {
  readonly completed: number;
  readonly failures: number;
  readonly total: number;
}

export interface PlanTreeState {
  readonly tasks: Map<string, RowState>;
  readonly label: string;
  readonly expanded: boolean;
  readonly viewport: PlanViewport;
  readonly busy: boolean;
  readonly outcome: PlanOutcome | undefined;
  readonly output: unknown;
  readonly view: PlanView;
}

export interface PlanTreeOptions {
  readonly detailed?: boolean;
  readonly mode?: "review" | "apply";
  readonly label?: string;
  readonly titleDetail?: string;
  readonly viewport?: PlanViewport;
  readonly busy?: boolean;
  /**
   * Initial collapse state of a collapsible tree. Dev passes the user's
   * last choice so a hot reload doesn't bring back a widget they hid.
   * @default true
   */
  readonly expanded?: boolean;
}

/** Display-only plans, such as cloud inventories, need no engine state or providers. */
export interface PlanTreeData {
  readonly rows: readonly PlanRow[];
  readonly summary: PlanSummaryCounts;
  readonly defaultMode?: ProviderMode;
}

const getRowKey = (item: FlattenedItem) => item.path.join("/");

const findCrudByLogicalId = (plan: Plan, id: string): CRUD | undefined =>
  [...Object.values(plan.resources), ...Object.values(plan.deletions)].find(
    (item): item is CRUD => item?.resource.LogicalId === id,
  );

const buildRows = (plan: Plan, detailed: boolean): PlanRow[] => {
  const resources = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions).filter(
      (item): item is NonNullable<Plan["deletions"][string]> =>
        item !== undefined,
    ),
  ] as CRUD[];
  const actions = [
    ...Object.values(plan.actions ?? {}),
    ...Object.values(plan.actionDeletions ?? {}),
  ].filter((task): task is ActionApply | ActionDelete => task !== undefined);

  return flattenTree(buildNamespaceTree(resources, actions), {
    includePropertyYaml: detailed,
  }).map((item) => {
    if (item.type === "namespace") {
      return {
        key: getRowKey(item),
        type: "namespace" as const,
        id: item.id,
        depth: item.depth,
        action: item.action,
      };
    }
    if (item.type === "binding") {
      return {
        key: getRowKey(item),
        type: "binding" as const,
        id: item.bindingSid ?? item.id,
        depth: item.depth,
        action: item.action as "create" | "update" | "delete" | "noop",
        hostKey: item.path.slice(0, -1).join("/"),
      };
    }
    if (item.type === "action") {
      return {
        key: getRowKey(item),
        type: "task" as const,
        id: item.id,
        depth: item.depth,
        action: item.action as ActionVerb,
      };
    }
    return {
      key: getRowKey(item),
      type: "resource" as const,
      id: item.id,
      resourceType: item.resourceType ?? "Unknown",
      depth: item.depth,
      action: item.action as CRUD["action"],
      providerMode: item.providerMode,
      fromProviderMode: item.fromProviderMode,
      propertyYaml: item.propertyYaml,
      persistedApplyStatus:
        item.action === "noop"
          ? (() => {
              const crud = findCrudByLogicalId(plan, item.id);
              return crud?.action === "noop" ? crud.state.status : undefined;
            })()
          : undefined,
    };
  });
};

export const initialResourceState = (row: ResourceRow): RowState => ({
  key: row.key,
  id: row.id,
  status:
    row.action === "noop" ? (row.persistedApplyStatus ?? "created") : "pending",
});

const buildInitialTasks = (rows: readonly PlanRow[]) =>
  new Map(
    rows.flatMap((row): Array<[string, RowState]> => {
      if (row.type === "resource")
        return [[row.key, initialResourceState(row)]];
      if (row.type === "task") {
        return [
          [
            row.key,
            {
              key: row.key,
              id: row.id,
              status: row.action === "noop" ? "skipped" : "pending",
            },
          ],
        ];
      }
      return [];
    }),
  );

export class PlanTree {
  readonly rows: readonly PlanRow[];
  readonly progressRows: readonly PlanRow[];
  readonly summary: PlanSummaryCounts;
  readonly mode: "review" | "apply";
  readonly detailed: boolean;
  readonly titleDetail?: string;
  readonly defaultMode?: ProviderMode;
  private state: PlanTreeState;
  private readonly listeners = new Set<() => void>();

  constructor(plan: Plan | PlanTreeData, options: PlanTreeOptions = {}) {
    this.detailed = options.detailed ?? false;
    this.mode = options.mode ?? "review";
    this.titleDetail = options.titleDetail;
    this.defaultMode = plan.defaultMode;
    this.rows = "rows" in plan ? plan.rows : buildRows(plan, this.detailed);
    this.progressRows = this.rows.filter(isProgressRow);
    this.summary = "rows" in plan ? plan.summary : buildPlanSummary(plan);
    this.state = {
      tasks: buildInitialTasks(this.rows),
      label: options.label ?? "Plan",
      expanded: options.expanded ?? true,
      viewport: options.viewport ?? "virtual",
      busy: options.busy ?? false,
      outcome: undefined,
      output: undefined,
      view: "plan",
    };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return this.state;
  }

  progress(): PlanProgress {
    let completed = 0;
    let failures = 0;
    let total = 0;
    for (const row of this.progressRows) {
      const status = this.state.tasks.get(row.key)?.status;
      if (row.action !== "noop") {
        total++;
        if (status !== undefined && isTerminalStatus(status)) completed++;
      }
      if (status === "fail") failures++;
    }
    return { completed, failures, total };
  }

  setExpanded(expanded: boolean) {
    this.update({ expanded });
  }

  setLabel(label: string) {
    this.update({ label });
  }

  setViewport(viewport: PlanViewport) {
    this.update({ viewport });
  }

  setBusy(busy: boolean) {
    this.update({
      busy,
      outcome: busy ? undefined : this.state.outcome,
      view: busy ? "plan" : this.state.view,
    });
  }

  finish(
    outcome: PlanOutcome,
    label: string,
    view: PlanView = this.state.view,
  ) {
    this.update({ busy: false, outcome, label, view });
  }

  setOutput(output: unknown) {
    this.update({ output });
  }

  setView(view: PlanView) {
    this.update({ view });
  }

  emit(event: ApplyEvent) {
    const tasks = new Map(this.state.tasks);
    const key = event.fqn;
    const now = Date.now();
    const timing = (current: RowState | undefined, status: ApplyStatus) => {
      const startedAt =
        current?.startedAt ?? (isInProgress(status) ? now : undefined);
      return {
        startedAt,
        elapsedMs:
          isTerminalStatus(status) && startedAt !== undefined
            ? now - startedAt
            : current?.elapsedMs,
      };
    };

    if (event._tag === "apply.resource.status") {
      const current = tasks.get(key);
      if (current) {
        tasks.set(key, {
          key,
          id: event.id,
          status: event.status,
          message: event.message ?? current.message,
          ...timing(current, event.status),
        });
      }
    } else {
      const current = tasks.get(key);
      if (current) tasks.set(key, { ...current, message: event.message });
    }

    this.update({ tasks });
  }

  private update(patch: Partial<PlanTreeState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
