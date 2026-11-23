import type {
  IssueAutomationCatalog,
  IssueAutomationError,
  IssueAutomationOverview,
  IssueTrackerKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Result from "effect/Result";

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

const make = Effect.gen(function* () {
  const automation = yield* IssueThreadAutomationService.IssueThreadAutomationService;

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
        // The caller's turn may have ended, or its modes changed, during the tracker read.
        const { overview, catalog } = yield* automation.edit(input, check);
        return view(input.tracker, overview, catalog, input.containerId);
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof IssueRulesToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(IssueRulesToolkit, make);
