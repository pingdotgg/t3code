import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestDetail, PullRequestRef } from "@t3tools/contracts";
import { ChevronDown, GitCompareArrows, LoaderCircle } from "lucide-react";
import { useContext, useState } from "react";

import { failureText } from "../settings/failureText";
import { pullRequestEnvironment } from "../state/prStatus";
import { PopMenu } from "../ui/PopMenu";
import { type PrActionItem, prActions } from "./prActions";

const BUTTON =
  "flex h-7 items-center justify-center gap-2 bg-message px-3 text-[11px] text-fg enabled:hover:bg-hover disabled:text-faint";

/** The pull request's primary action as Orca's split button, with the other actions in its menu. */
export function PrAction({
  environmentId,
  reference,
  detail,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetail;
}) {
  const registry = useContext(RegistryContext);
  const [working, setWorking] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const actions = prActions(detail);
  if (actions === null) return null;

  const run = async (action: PrActionItem) => {
    if (working !== null) return;
    setFailure(null);
    setWorking(action.kind);
    const result = await runAtomCommand(
      registry,
      pullRequestEnvironment.runAction,
      {
        environmentId,
        input: {
          ...reference,
          action: action.kind,
          ...(action.updateMethod === undefined ? {} : { updateMethod: action.updateMethod }),
        },
      },
      { reportFailure: false },
    );
    setWorking(null);
    if (result._tag === "Failure") setFailure(failureText(result));
  };
  const { primary, menu } = actions;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex overflow-hidden rounded-lg border border-line">
        <button
          type="button"
          data-testid="pr-action"
          data-action={primary.kind}
          disabled={primary.unavailable !== null || working !== null}
          onClick={() => void run(primary)}
          className={`${BUTTON} min-w-0 flex-1`}
        >
          {working === primary.kind ? (
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <GitCompareArrows className="size-3.5" aria-hidden />
          )}
          {working === primary.kind ? "Working" : primary.label}
        </button>
        <PopMenu
          label="More pull request actions"
          trigger={<ChevronDown className="size-3.5" aria-hidden />}
          triggerClass={`${BUTTON} h-full border-l border-line px-2`}
          items={menu.map((action) => ({
            label: action.label,
            hint: action.unavailable ?? undefined,
            disabled: action.unavailable !== null || working !== null,
            onSelect: () => void run(action),
          }))}
        />
      </div>
      {primary.unavailable !== null && working === null && (
        <p data-testid="pr-action-reason" className="text-[11px] text-muted">
          {primary.unavailable}
        </p>
      )}
      {failure !== null && (
        <p
          role="alert"
          data-testid="pr-action-failure"
          className="text-[11px] break-words text-red-300"
        >
          {failure}
        </p>
      )}
    </div>
  );
}
