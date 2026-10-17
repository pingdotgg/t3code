import {
  workflowOpeningHeadline,
  type WorkflowOpening,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { ServerProvider } from "@t3tools/contracts";
import { WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { WorkflowPhaseList } from "./ThreadLineageWorkflowRow";

/** Opens a workflow coordinator's thread in place of its script: the plan, then the script on demand. */
export function WorkflowOpeningBlock(props: {
  readonly opening: WorkflowOpening;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const [scriptOpen, setScriptOpen] = useState(false);
  const { opening } = props;
  const headline = workflowOpeningHeadline(opening);
  const provider = props.providers.find((entry) => entry.instanceId === opening.providerInstanceId);
  return (
    <section
      aria-label={`Workflow started: ${headline.title}`}
      className="flex flex-col gap-2 rounded-xl border border-border/80 p-3"
      data-workflow-opening
    >
      <header className="flex min-w-0 items-start gap-2">
        <WorkflowIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-2xs font-medium text-muted-foreground">Workflow started</p>
          <h3 className="truncate text-sm font-medium text-foreground">{headline.title}</h3>
          {headline.description ? (
            <p className="text-xs text-muted-foreground">{headline.description}</p>
          ) : null}
        </div>
        {headline.agents ? (
          <span aria-live="polite" className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {headline.agents}
          </span>
        ) : null}
      </header>
      {opening.group !== null && opening.providerInstanceId !== null ? (
        <WorkflowPhaseList
          group={opening.group}
          providerInstanceId={opening.providerInstanceId}
          provider={provider}
          providers={props.providers}
          driver={opening.driver ?? provider?.driver}
          onOpenThread={props.onOpenThread}
          isThreadAvailable={() => true}
        />
      ) : null}
      <div>
        <CollapsibleSectionHeader
          expanded={scriptOpen}
          aria-label={`${scriptOpen ? "Hide" : "View"} workflow script`}
          onClick={() => setScriptOpen((open) => !open)}
        >
          View script
        </CollapsibleSectionHeader>
        {scriptOpen ? (
          <pre className="mt-1 max-h-96 overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-2xs whitespace-pre text-foreground/90">
            {opening.script}
          </pre>
        ) : null}
      </div>
    </section>
  );
}
