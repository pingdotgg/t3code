import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { LoaderCircle } from "lucide-react";
import type { IssueListEntry, IssueRef } from "@t3tools/contracts";
import { type FormEvent, useContext, useState } from "react";

import { messageOrchestrator } from "../foryou/actions";
import { readIssueBrief } from "../state/issues";
import { settingsPageAtom } from "../state/settingsPage";
import { ticketRequestMessage } from "./issueLinks";
import { IssuePicker } from "./IssuePicker";

const entryRef = ({ projectId, tracker, host, scope, key }: IssueListEntry): IssueRef => ({
  projectId,
  tracker,
  host,
  scope,
  key,
});

export function AddFromIssue({
  project,
  orchestratorThreadId,
  onDone,
}: {
  project: EnvironmentProject;
  orchestratorThreadId: string;
  onDone: () => void;
}) {
  const registry = useContext(RegistryContext);
  const [issue, setIssue] = useState<IssueListEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (issue === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const brief = await readIssueBrief(registry, project.environmentId, entryRef(issue));
      const failure = await messageOrchestrator(
        registry,
        project.environmentId,
        orchestratorThreadId,
        async () => ticketRequestMessage(brief),
      );
      if (failure === null) onDone();
      else setError(failure);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center bg-black/50"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onDone();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Add a ticket from an issue"
        onSubmit={(event) => void submit(event)}
        className="flex w-[512px] max-w-[92vw] flex-col gap-4 rounded-xl border border-line bg-panel p-6 shadow-panel"
      >
        <h2 className="text-base font-semibold">Add a ticket from an issue</h2>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-medium text-muted">Issue</p>
          <IssuePicker
            project={project}
            source={issue}
            onPick={setIssue}
            onOpenIntegrations={() => {
              registry.set(settingsPageAtom, "integrations");
              onDone();
            }}
          />
        </div>
        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs break-words text-red-400"
          >
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onDone}
            disabled={busy}
            className="text-xs text-muted hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={issue === null || busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
          >
            {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
            Add ticket
          </button>
        </div>
      </form>
    </div>
  );
}
