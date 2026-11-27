import {
  allWorkflowRunNodes,
  groupWorkflowRuns,
  readWorkflowQuestion,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunsAboutInput } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useWorkflowEnvironmentIds } from "./useWorkflowEnvironmentIds";
import { WorkflowChip, WorkflowStateWord } from "./WorkflowRunFeed";

/** The workflow runs whose subject is `item`, on that item's own view. */
export function WorkflowRunsAbout({
  environmentId,
  item,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: WorkflowRunsAboutInput;
}) {
  const gt = useGT();
  const enabled = useWorkflowEnvironmentIds().includes(environmentId);
  const about = useEnvironmentQuery(
    enabled ? serverEnvironment.workflowRunsAbout({ environmentId, input: item }) : null,
  );
  if (!about.data || about.data.runs.length === 0) return null;
  const nodes = allWorkflowRunNodes(groupWorkflowRuns([], about.data.runs, about.data.questions));
  return (
    <section className="mt-3 space-y-1">
      <h3 className="text-meta text-muted-foreground">{gt("Workflow runs")}</h3>
      <ul className="space-y-0.5">
        {nodes.map((node) => {
          const question = node.questions[0];
          return (
            <li key={node.run.runId}>
              <Link
                to="/workflows"
                search={{ env: environmentId, run: node.run.runId }}
                className="flex min-w-0 items-center gap-1.5 rounded-row px-1.5 py-1 text-meta hover:surface-ghost-hover focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset focus-visible:outline-none"
              >
                <WorkflowChip name={node.run.workflow} />
                <span className="min-w-0 flex-1 truncate text-foreground">{node.run.title}</span>
                {question === undefined ? null : (
                  <span className="min-w-0 max-w-1/2 truncate text-muted-foreground">
                    {readWorkflowQuestion(question).title}
                  </span>
                )}
                <WorkflowStateWord node={node} />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
