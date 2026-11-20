import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useContext, useState } from "react";

import { openInBrowser } from "../browser/browserTabs";
import { runGitAction, tellOrchestrator, vcsActionManager } from "../state/changes";
import { PopMenu, type PopMenuItem } from "../ui/PopMenu";
import { commitSummary } from "./commitSummary";

/** Set for a ticket worktree, where the orchestrator can be told what was committed. */
export interface TellTarget {
  readonly orchestratorThreadId: string | null;
  readonly worktree: string;
}

type Outcome =
  | { readonly ok: true; readonly result: GitRunStackedActionResult }
  | { readonly ok: false; readonly message: string };

const pushes = (action: GitStackedAction) =>
  action === "commit_push" || action === "commit_push_pr";

/**
 * The commit box of Orca's source control view: a message, a Commit button, and a menu that adds a
 * push or a push and a pull request. T3 commits everything changed, and writes the message when the box is empty.
 */
export function CommitBox({
  environmentId,
  cwd,
  status,
  tell,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  status: VcsStatusResult | null;
  tell: TellTarget | null;
}) {
  const registry = useContext(RegistryContext);
  const run = useAtomValue(vcsActionManager.stateAtom({ environmentId, cwd }));
  const [message, setMessage] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirm, setConfirm] = useState<GitStackedAction | null>(null);
  const [told, setTold] = useState<"idle" | "sending" | "sent">("idle");
  const [tellFailure, setTellFailure] = useState<string | null>(null);
  const changed = status?.hasWorkingTreeChanges === true;
  const ahead = status?.aheadCount ?? 0;
  const pr = status?.pr ?? null;
  const branch = status?.refName ?? "this branch";

  const start = async (action: GitStackedAction) => {
    setConfirm(null);
    setOutcome(null);
    setTold("idle");
    setTellFailure(null);
    const done = await runGitAction(registry, { environmentId, cwd }, action, message.trim());
    if (done.ok) setMessage("");
    setOutcome(done);
  };
  const request = (action: GitStackedAction) => {
    if (pushes(action) && status?.isDefaultRef === true) setConfirm(action);
    else void start(action);
  };

  const items: ReadonlyArray<PopMenuItem> = [
    {
      label: "Commit",
      hint: changed ? undefined : "Nothing to commit",
      disabled: !changed,
      onSelect: () => request("commit"),
    },
    {
      label: "Commit & Push",
      hint: changed
        ? status?.hasUpstream === true
          ? undefined
          : "Sets upstream"
        : ahead > 0
          ? `Pushes ${ahead} ${ahead === 1 ? "commit" : "commits"}`
          : "Nothing to push",
      disabled: !changed && ahead === 0,
      onSelect: () => request("commit_push"),
    },
    {
      label: "Commit, Push & Create PR",
      hint: pr === null ? undefined : `PR #${pr.number} exists`,
      disabled: !changed && ahead === 0 && pr !== null,
      onSelect: () => request("commit_push_pr"),
    },
  ];

  return (
    <div className="flex flex-col gap-2 px-2.5 pb-2.5" data-testid="commit-box">
      <textarea
        aria-label="Commit message"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Message"
        rows={2}
        className="w-full resize-none rounded-lg border border-line bg-panel px-2.5 py-2 text-[12px] text-fg placeholder:text-faint"
      />
      <div className="flex rounded-lg border border-line">
        <button
          type="button"
          disabled={!changed || run.isRunning}
          onClick={() => request("commit")}
          className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-lg py-1 text-[12px] font-semibold text-muted enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-60"
        >
          {run.isRunning ? (
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Check className="size-3.5" aria-hidden />
          )}
          <span className="truncate">
            {run.isRunning ? (run.currentLabel ?? "Working") : "Commit"}
          </span>
        </button>
        <PopMenu
          label="More commit actions"
          trigger={<ChevronDown className="size-3.5" aria-hidden />}
          items={items}
          triggerClass="grid h-full w-7 place-items-center rounded-r-lg border-l border-line text-muted hover:bg-hover hover:text-fg"
        />
      </div>
      {confirm !== null && (
        <div
          role="alertdialog"
          aria-label="Push the default branch"
          className="flex flex-col gap-1.5 rounded-lg border border-amber-400/40 px-2.5 py-2 text-[12px] text-amber-300"
        >
          <p>{branch} is the default branch. Push to it directly?</p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => void start(confirm)}
              className="rounded-md border border-amber-400/50 px-2 py-0.5 hover:bg-hover"
            >
              Push to {branch}
            </button>
            <button
              type="button"
              onClick={() => setConfirm(null)}
              className="rounded-md px-2 py-0.5 text-muted hover:bg-hover"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {outcome !== null && !outcome.ok && (
        <p role="alert" className="text-[12px] break-words text-red-300">
          {outcome.message}
        </p>
      )}
      {outcome?.ok === true && (
        <div role="status" data-testid="commit-result" className="flex flex-col gap-1 text-[12px]">
          <p className="text-emerald-300">{outcome.result.toast.title}</p>
          {outcome.result.toast.description !== undefined && (
            <p className="break-words text-muted">{outcome.result.toast.description}</p>
          )}
          <div className="flex gap-1.5">
            {outcome.result.pr.url !== undefined && (
              <button
                type="button"
                onClick={() => openInBrowser(outcome.result.pr.url ?? "")}
                className="rounded-md border border-line px-2 py-0.5 text-fg hover:bg-hover"
              >
                Open PR
              </button>
            )}
            {tell !== null && (
              <button
                type="button"
                disabled={told === "sending" || told === "sent"}
                onClick={() => {
                  setTold("sending");
                  setTellFailure(null);
                  void tellOrchestrator(
                    registry,
                    environmentId,
                    tell.orchestratorThreadId,
                    commitSummary(tell.worktree, outcome.result),
                  ).then((failure) => {
                    setTold(failure === null ? "sent" : "idle");
                    setTellFailure(failure);
                  });
                }}
                className="rounded-md border border-line px-2 py-0.5 text-fg hover:bg-hover disabled:text-muted"
              >
                {told === "sent" ? "Orchestrator told" : "Tell the orchestrator"}
              </button>
            )}
          </div>
          {tellFailure !== null && (
            <p role="alert" className="text-red-300">
              {tellFailure}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
