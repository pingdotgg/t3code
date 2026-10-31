import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { linearMoveHint } from "@t3tools/client-runtime/linear/launch-plan";

function HintToggle({
  label,
  shortLabel,
  enabled,
  onToggle,
}: {
  readonly label: string;
  readonly shortLabel: string;
  readonly enabled: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={onToggle}
            className={cn(
              "truncate rounded-sm px-0.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              !enabled && "line-through opacity-60",
            )}
          />
        }
      >
        <span className="max-sm:hidden">{label}</span>
        <span className="sm:hidden">{shortLabel}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{enabled ? "Turn off" : "Turn on"} for this launch</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Composer footer note for a draft started from a Linear issue: what sending will write back to
 * Linear. Each part toggles for this launch only; the saved defaults live in Linear settings.
 */
export function LinearLaunchHint({ draftTarget }: { readonly draftTarget: ComposerThreadTarget }) {
  const launch = useComposerDraftStore(
    (state) => state.getDraftThread(draftTarget)?.linearIssue ?? null,
  );
  const newWorktree = useComposerDraftStore((state) => {
    const draft = state.getDraftThread(draftTarget);
    return draft?.envMode === "worktree" && draft.worktreePath === null;
  });
  const setDraftLinearIssue = useComposerDraftStore((state) => state.setDraftLinearIssue);
  if (launch === null) return null;
  const moveLabel = linearMoveHint(launch);
  return (
    <div
      data-chat-composer-linear-hint="true"
      className="flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground"
    >
      {newWorktree ? (
        <>
          <span className="min-w-0 truncate max-sm:hidden">worktree on {launch.branchName}</span>
          <span aria-hidden className="max-sm:hidden">
            ·
          </span>
        </>
      ) : null}
      {moveLabel !== null && launch.moveTo ? (
        <>
          <HintToggle
            label={moveLabel}
            shortLabel={`→ ${launch.moveTo.name}`}
            enabled={launch.moveEnabled}
            onToggle={() =>
              setDraftLinearIssue(draftTarget, { ...launch, moveEnabled: !launch.moveEnabled })
            }
          />
          <span aria-hidden>·</span>
        </>
      ) : null}
      <HintToggle
        label="comments link"
        shortLabel="comment"
        enabled={launch.commentEnabled}
        onToggle={() =>
          setDraftLinearIssue(draftTarget, { ...launch, commentEnabled: !launch.commentEnabled })
        }
      />
    </div>
  );
}
