import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ImproveJob, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, RotateCcwIcon, WandIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { improveEnvironment } from "../../state/improve";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { commandFailureText } from "../continuum/commandFailure";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SuperchargeRunStatus } from "./SuperchargeControl";
import { SpeechPlaybackBar } from "../../speech/SpeechPlaybackBar";

const PHASE_LABELS: Record<ImproveJob["phase"], string> = {
  rewriting: "Improving your prompt…",
  rewritten: "Prompt improved",
  launching: "Opening the new session…",
  launched: "Opened in a new session",
  failed: "Failed",
};

/** Status rows above the composer: `/improve` jobs and the Supercharge run for this thread. */
export function ContinuumComposerStatus({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const jobsQuery = useEnvironmentQuery(
    improveEnvironment.jobs({
      environmentId: threadRef.environmentId,
      input: { sourceThreadId: threadRef.threadId },
    }),
  );
  const jobs = (jobsQuery.data ?? []).slice(-3);
  return (
    <div className="flex flex-col gap-1 empty:hidden">
      <SpeechPlaybackBar />
      <SuperchargeRunStatus threadRef={threadRef} />
      {jobs.map((job) => (
        <ImproveJobRow
          key={job.requestId}
          threadRef={threadRef}
          job={job}
          onChanged={jobsQuery.refresh}
        />
      ))}
    </div>
  );
}

function ImproveJobRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly job: ImproveJob;
  readonly onChanged: () => void;
}) {
  const { job, threadRef } = props;
  const navigate = useNavigate();
  const retry = useAtomCommand(improveEnvironment.retry, { reportFailure: false });
  const dismiss = useAtomCommand(improveEnvironment.dismiss, { reportFailure: false });
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const working = job.phase === "rewriting" || job.phase === "launching";

  return (
    <div
      className="rounded-lg border border-border bg-card/70 px-2.5 py-1.5 text-xs shadow-xs backdrop-blur"
      data-improve-job={job.phase}
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <WandIcon
          className={cn("size-3.5 shrink-0 text-primary", working && "motion-safe:animate-pulse")}
        />
        <span className="font-medium">/improve</span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            job.phase === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {job.phase === "failed" && job.error ? job.error : PHASE_LABELS[job.phase]}
        </span>
        {job.phase === "launched" && job.newThreadId ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(threadRef.environmentId, job.newThreadId!),
                ),
              })
            }
          >
            Open <ArrowUpRightIcon />
          </Button>
        ) : null}
        {job.phase === "failed" ? (
          <Button
            size="xs"
            variant="outline"
            onClick={async () => {
              const result = await retry({
                environmentId: threadRef.environmentId,
                input: {
                  requestId: job.requestId,
                  ...(editing !== null && editing.trim() ? { improvedPrompt: editing.trim() } : {}),
                },
              });
              setError(commandFailureText(result, "The retry did not start."));
              props.onChanged();
            }}
          >
            <RotateCcwIcon /> Retry
          </Button>
        ) : null}
        {job.improvedPrompt && job.phase !== "launched" && editing === null ? (
          <Button size="xs" variant="ghost" onClick={() => setEditing(job.improvedPrompt ?? "")}>
            Edit
          </Button>
        ) : null}
        {!working ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss"
            onClick={async () => {
              await dismiss({
                environmentId: threadRef.environmentId,
                input: { requestId: job.requestId },
              });
              props.onChanged();
            }}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      {editing !== null ? (
        <Textarea
          className="mt-1.5"
          value={editing}
          aria-label="Improved prompt"
          onChange={(event) => setEditing(event.target.value)}
        />
      ) : job.improvedPrompt && job.phase !== "launched" ? (
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-muted-foreground">
          {job.improvedPrompt}
        </p>
      ) : null}
      {error ? <p className="mt-1 text-destructive">{error}</p> : null}
    </div>
  );
}
