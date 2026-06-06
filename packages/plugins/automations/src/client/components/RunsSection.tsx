import type { PluginUiContext } from "@t3tools/plugin-api/ui";

import type { AutomationRule, AutomationRun } from "../../shared/schema.ts";
import { formatDateTime, runStatusTone } from "../domain.ts";
import type { PluginProject } from "../types.ts";

export function RunsSection({
  ctx,
  runs,
  ruleById,
  projectById,
}: {
  readonly ctx: PluginUiContext;
  readonly runs: ReadonlyArray<AutomationRun>;
  readonly ruleById: ReadonlyMap<string, AutomationRule>;
  readonly projectById: ReadonlyMap<string, PluginProject>;
}) {
  const React = ctx.react;
  const C = ctx.components;

  return (
    <React.Fragment>
      <C.Section title="Recent Runs">
        {runs.length === 0 ? (
          <C.List>
            <C.EmptyState title="No run history yet" />
          </C.List>
        ) : (
          <C.List>
            {runs.map((run) => {
              const rule = ruleById.get(run.ruleId);
              const project = rule ? projectById.get(rule.projectId) : null;
              const href =
                run.threadId && project
                  ? ctx.host.threadHref({
                      environmentId: project.environmentId,
                      threadId: run.threadId,
                    })
                  : null;

              return (
                <C.ListRow
                  key={run.id}
                  actions={
                    href ? (
                      <C.Link href={href} onClick={() => ctx.navigation.navigate(href)}>
                        Thread
                      </C.Link>
                    ) : null
                  }
                >
                  <C.Stack gap="xs">
                    <C.Inline gap="sm">
                      <C.Badge tone={runStatusTone(run.status)}>{run.status}</C.Badge>
                      <C.Text title={rule?.name ?? run.ruleId} truncate variant="heading">
                        {rule?.name ?? run.ruleId}
                      </C.Text>
                      {run.reason ? (
                        <C.Text tone="muted" variant="caption">
                          {run.reason}
                        </C.Text>
                      ) : null}
                    </C.Inline>
                    <C.Text tone={run.error ? "danger" : "muted"} variant="caption">
                      {formatDateTime(run.scheduledFor, rule?.timezone)}
                      {run.error ? ` - ${run.error}` : ""}
                    </C.Text>
                  </C.Stack>
                </C.ListRow>
              );
            })}
          </C.List>
        )}
      </C.Section>
    </React.Fragment>
  );
}
