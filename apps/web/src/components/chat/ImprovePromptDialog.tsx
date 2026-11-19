import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isProviderTextGenerationCapable,
  type ImproveJob,
  type ModelSelection,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import { improveEnvironment } from "../../state/improve";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";

function modelId(selection: ModelSelection): string {
  return JSON.stringify([selection.instanceId, selection.model]);
}

function modelOptions(providers: ReadonlyArray<ProviderInstanceEntry>, textOnly: boolean) {
  return providers
    .filter(
      (provider) =>
        isProviderInstancePickerReady(provider) &&
        (!textOnly || isProviderTextGenerationCapable(provider.snapshot)),
    )
    .flatMap((provider) =>
      provider.models
        .filter((model) => !textOnly || model.supportsTextGeneration !== false)
        .map((model) => ({
          label: `${provider.displayName} · ${model.name}`,
          selection: { instanceId: provider.instanceId, model: model.slug },
        })),
    );
}

const PHASE_LABELS: Record<ImproveJob["phase"], string> = {
  rewriting: "Rewriting",
  rewritten: "Rewritten",
  launching: "Opening thread",
  launched: "Ready",
  failed: "Failed",
};

export function ImprovePromptDialog({
  threadRef,
  initialPrompt,
  providers,
  activeModel,
  onClose,
  onOpenThread,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly initialPrompt: string;
  readonly providers: ReadonlyArray<ProviderInstanceEntry>;
  readonly activeModel: ModelSelection;
  readonly onClose: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId, threadId } = threadRef;
  const jobs = useEnvironmentQuery(
    improveEnvironment.jobs({ environmentId, input: { sourceThreadId: threadId } }),
  );
  const start = useAtomCommand(improveEnvironment.start, { reportFailure: false });
  const retry = useAtomCommand(improveEnvironment.retry, { reportFailure: false });
  const dismiss = useAtomCommand(improveEnvironment.dismiss, { reportFailure: false });
  const canStart = useAtomValue(improveEnvironment.start.permissionAtom(environmentId));
  const canRetry = useAtomValue(improveEnvironment.retry.permissionAtom(environmentId));
  const canDismiss = useAtomValue(improveEnvironment.dismiss.permissionAtom(environmentId));
  const [prompt, setPrompt] = useState(initialPrompt);
  const [improverId, setImproverId] = useState<string | null>(null);
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const improvers = modelOptions(providers, true);
  const destinations = modelOptions(providers, false);
  const improver =
    improvers.find((entry) => modelId(entry.selection) === (improverId ?? modelId(activeModel))) ??
    improvers[0];
  const destination =
    destinations.find(
      (entry) => modelId(entry.selection) === (destinationId ?? modelId(activeModel)),
    ) ?? destinations[0];
  const report = (result: Awaited<ReturnType<typeof start>>) => {
    if (result._tag === "Success") {
      if (result.value.newThreadId) onOpenThread(result.value.newThreadId);
      else if (result.value.error) setError(result.value.error);
      setRequestId(null);
    } else {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not improve the prompt.");
    }
    jobs.refresh();
  };
  const begin = async () => {
    if (!canStart || busy || !prompt.trim() || !improver || !destination) return;
    const id = requestId ?? randomUUID();
    setRequestId(id);
    setBusy(id);
    setError(null);
    await (async () => {
      report(
        await start({
          environmentId,
          input: {
            requestId: id,
            sourceThreadId: threadId,
            prompt: prompt.trim(),
            improver: improver.selection,
            destination: destination.selection,
          },
        }),
      );
    })().catch((error: unknown) => {
      setError(error instanceof Error ? error.message : "Could not improve the prompt.");
    });
    setBusy(null);
  };
  const retryJob = async (job: ImproveJob) => {
    setBusy(job.requestId);
    setError(null);
    await (async () => {
      report(
        await retry({
          environmentId,
          input: {
            requestId: job.requestId,
            ...(job.failedStep === "rewrite" && improverId !== null && improver
              ? { improver: improver.selection }
              : {}),
            ...(destinationId !== null && destination
              ? { destination: destination.selection }
              : {}),
          },
        }),
      );
    })().catch((error: unknown) => {
      setError(error instanceof Error ? error.message : "Could not improve the prompt.");
    });
    setBusy(null);
  };
  const dismissJob = async (job: ImproveJob) => {
    const result = await dismiss({ environmentId, input: { requestId: job.requestId } });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not dismiss the job.");
    }
    jobs.refresh();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogTitle>Improve prompt</DialogTitle>
        <DialogDescription>
          Use this thread for context, then send the improved prompt to a new thread.
        </DialogDescription>
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void begin();
          }}
        >
          <label className="block">
            Prompt
            <textarea
              className="mt-1 block min-h-24 w-full rounded border bg-background p-2"
              value={prompt}
              disabled={busy !== null}
              onChange={(event) => {
                setRequestId(null);
                setPrompt(event.currentTarget.value);
              }}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              Improver
              <select
                className="mt-1 block w-full rounded border bg-background p-2"
                disabled={busy !== null}
                value={improver ? modelId(improver.selection) : ""}
                onChange={(event) => {
                  setRequestId(null);
                  setImproverId(event.currentTarget.value);
                }}
              >
                {improvers.map((option) => (
                  <option key={modelId(option.selection)} value={modelId(option.selection)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              Destination model
              <select
                className="mt-1 block w-full rounded border bg-background p-2"
                disabled={busy !== null}
                value={destination ? modelId(destination.selection) : ""}
                onChange={(event) => {
                  setRequestId(null);
                  setDestinationId(event.currentTarget.value);
                }}
              >
                {destinations.map((option) => (
                  <option key={modelId(option.selection)} value={modelId(option.selection)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {improver && destination ? null : (
            <p className="text-sm text-muted-foreground">
              A ready improver and destination model are required.
            </p>
          )}
          {(error ?? jobs.error) ? (
            <Alert variant="error">
              <AlertDescription>{error ?? jobs.error}</AlertDescription>
            </Alert>
          ) : null}
          <Button
            type="submit"
            disabled={!canStart || busy !== null || !prompt.trim() || !improver || !destination}
          >
            {busy ? "Working…" : "Improve and open thread"}
          </Button>
        </form>
        {jobs.data?.length ? (
          <section className="mt-4 space-y-2 border-t pt-3">
            <h3 className="font-medium">Previous jobs</h3>
            <ul className="max-h-52 space-y-2 overflow-y-auto">
              {jobs.data.map((job) => (
                <li key={job.requestId} className="space-y-1 rounded border p-2 text-sm">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 break-words">{job.originalPrompt}</p>
                    <Badge variant={job.phase === "failed" ? "error" : "secondary"}>
                      {PHASE_LABELS[job.phase]}
                    </Badge>
                  </div>
                  {job.error ? <p>{job.error}</p> : null}
                  <div className="flex gap-2">
                    {job.newThreadId ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => onOpenThread(job.newThreadId!)}
                      >
                        Open thread
                      </Button>
                    ) : null}
                    {job.phase === "failed" || job.phase === "rewritten" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!canRetry || busy !== null}
                        onClick={() => void retryJob(job)}
                      >
                        Retry
                      </Button>
                    ) : null}
                    {job.phase === "failed" || job.phase === "launched" ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={!canDismiss || busy !== null}
                        onClick={() => void dismissJob(job)}
                      >
                        Dismiss
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
