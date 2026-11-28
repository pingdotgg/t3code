import {
  allWorkflowRunNodes,
  foldWorkflowRunsAbout,
  groupWorkflowRuns,
  readWorkflowQuestion,
  workflowRunOutcome,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunsAboutInput } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useWorkflowEnvironmentIds } from "./useWorkflowEnvironmentIds";
import { Button } from "../ui/button";
import { WorkflowStateIcon, WorkflowStateWord } from "./WorkflowRunFeed";

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
  const [unfolded, setUnfolded] = useState(false);
  const about = useEnvironmentQuery(
    enabled ? serverEnvironment.workflowRunsAbout({ environmentId, input: item }) : null,
  );
  if (!about.data || about.data.runs.length === 0) return null;
  const workflows = about.data.workflows ?? [];
  const { shown, folded } = foldWorkflowRunsAbout(
    allWorkflowRunNodes(groupWorkflowRuns([], about.data.runs, about.data.questions)),
    workflows,
    about.data.worked ?? null,
  );
  const nodes = unfolded ? [...shown, ...folded] : shown;
  return (
    <section className="mt-3 space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground">{gt("Workflow runs")}</h3>
      <ul className="space-y-0.5">
        {nodes.map((node) => {
          const question = node.questions[0];
          const outcome = workflowRunOutcome(node.run);
          return (
            <li key={node.run.runId}>
              <Link
                to="/workflows"
                search={{ env: environmentId, run: node.run.runId }}
                className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset focus-visible:outline-none"
              >
                <WorkflowStateIcon node={node} />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {/* A workflow with no title of its own is told by its run's title, not its key. */}
                  {workflows.find((workflow) => workflow.name === node.run.workflow)?.title ??
                    node.run.title}
                </span>
                {question === undefined ? null : (
                  <span className="min-w-0 max-w-1/2 truncate text-muted-foreground">
                    {readWorkflowQuestion(question).title}
                  </span>
                )}
                {outcome === null ? (
                  <WorkflowStateWord node={node} bare />
                ) : (
                  <span className="min-w-0 max-w-1/2 truncate text-muted-foreground">
                    {outcome}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      {folded.length === 0 ? null : (
        <Button size="xs" variant="ghost" onClick={() => setUnfolded(!unfolded)}>
          {unfolded
            ? gt("Show fewer")
            : gt("{count} more", {
                count: folded.length,
                $context: "workflow runs on an item that did nothing worth reading",
              })}
        </Button>
      )}
    </section>
  );
}
