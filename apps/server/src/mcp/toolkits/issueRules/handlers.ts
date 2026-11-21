import {
  IssueAutomationError,
  type IssueAutomationAction,
  type IssueAutomationCatalog,
  type IssueAutomationOverview,
  type IssueAutomationRule,
  type IssueAutomationSaveInput,
  type IssueTrackerKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Result from "effect/Result";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as IssueThreadAutomationService from "../../../issue/IssueThreadAutomationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { IssueRulesToolkit, type IssueStatusRulesResult } from "./tools.ts";

type CatalogRead = Result.Result<IssueAutomationCatalog, IssueAutomationError>;

function view(
  tracker: IssueTrackerKind,
  overview: IssueAutomationOverview,
  catalog: CatalogRead,
  containerId: string | undefined,
): IssueStatusRulesResult {
  const rules = overview.rules.filter((rule) => rule.tracker === tracker);
  const read = catalog._tag === "Success" ? catalog.success : undefined;
  const mappings = rules.find((rule) => rule.containerId === containerId)?.mappings ?? {};
  return {
    rules: rules.map((rule) => {
      const status = overview.status.find((entry) => entry.ruleId === rule.id);
      return {
        id: rule.id,
        enabled: rule.enabled,
        workspace: rule.workspace,
        containerId: rule.containerId,
        containerName: rule.containerName,
        mappings: rule.mappings,
        checkedAt: status?.checkedAt ?? null,
        error: status?.error ?? null,
      };
    }),
    containers: read?.containers ?? [],
    statuses: (read?.states ?? []).map((state) => ({
      ...state,
      action: mappings[state.id] ?? null,
    })),
    ...(catalog._tag === "Failure" ? { error: catalog.failure.message } : {}),
  };
}

/** Applies statuses named by name or id; a mapped id the tracker no longer lists can be cleared. */
const applyStatuses = Effect.fn("IssueRulesToolkit.applyStatuses")(function* (
  current: IssueAutomationRule["mappings"],
  requested: Readonly<Record<string, IssueAutomationAction | null>>,
  states: IssueAutomationCatalog["states"],
) {
  const next = new Map(Object.entries(current));
  for (const [key, action] of Object.entries(requested)) {
    const id =
      next.has(key) || states.some((state) => state.id === key)
        ? key
        : states.find((state) => state.name.toLowerCase() === key.toLowerCase())?.id;
    if (id === undefined)
      return yield* new IssueAutomationError({
        operation: "save",
        detail: `No status is named ${key}. Statuses: ${states.map((state) => state.name).join(", ")}.`,
      });
    if (action === null) next.delete(id);
    else next.set(id, action);
  }
  return Object.fromEntries(next);
});

const sameMappings = (
  left: IssueAutomationRule["mappings"],
  right: IssueAutomationRule["mappings"],
) =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(left).every(([id, action]) => right[id] === action);

const make = Effect.gen(function* () {
  const automation = yield* IssueThreadAutomationService.IssueThreadAutomationService;
  const random = yield* SecureRandom.SecureRandom;

  return {
    list_issue_status_rules: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        yield* McpInvocationContext.requireMcpCapability("issues");
        const overview = yield* automation.overview;
        const catalog = yield* automation.catalog(input).pipe(Effect.result);
        return view(input.tracker, overview, catalog, input.containerId);
      }),
    ),
    set_issue_status_rule: McpToolAccess.writesEnvironment((input, check) =>
      Effect.gen(function* () {
        yield* McpInvocationContext.requireMcpCapability("issues");
        const { tracker, containerId } = input;
        const catalog = yield* automation.catalog({ tracker, containerId }).pipe(Effect.result);
        const before = yield* automation.overview;
        const existing = before.rules.find(
          (rule) => rule.tracker === tracker && rule.containerId === containerId,
        );
        let change: IssueAutomationSaveInput | undefined;
        if (input.remove === true) {
          change = existing === undefined ? undefined : { id: existing.id, rule: null };
        } else if (existing === undefined) {
          if (catalog._tag === "Failure") return yield* catalog.failure;
          const { workspace, containers, states } = catalog.success;
          const rule: IssueAutomationRule = {
            id: yield* random.uuidV4().pipe(Effect.orDie),
            enabled: input.enabled ?? true,
            tracker,
            workspace,
            containerId,
            containerName:
              containers.find((container) => container.id === containerId)?.name ?? containerId,
            mappings: yield* applyStatuses({}, input.statuses ?? {}, states),
          };
          change = { id: rule.id, rule };
        } else {
          // Like Settings, a rule the tracker cannot reach now can still be switched off.
          if (catalog._tag === "Failure" && input.statuses !== undefined)
            return yield* catalog.failure;
          const states = catalog._tag === "Success" ? catalog.success.states : [];
          const rule: IssueAutomationRule = {
            ...existing,
            enabled: input.enabled ?? existing.enabled,
            mappings: yield* applyStatuses(existing.mappings, input.statuses ?? {}, states),
          };
          // Every save starts a new baseline, so an unchanged rule is not saved again.
          const unchanged =
            rule.enabled === existing.enabled && sameMappings(rule.mappings, existing.mappings);
          change = unchanged ? undefined : { id: rule.id, rule };
        }
        if (change === undefined) return view(tracker, before, catalog, containerId);
        // The caller's turn may have ended, or its modes changed, during the tracker reads.
        yield* check;
        return view(tracker, yield* automation.save(change), catalog, containerId);
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof IssueRulesToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(IssueRulesToolkit, make);
