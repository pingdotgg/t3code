import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  attachedLinearDraftIssue,
  linearMoveHint,
} from "@t3tools/client-runtime/linear/launch-plan";

function HintToggle({
  label,
  shortLabel,
  enabled,
  shrink = false,
  onToggle,
}: {
  readonly label: string;
  readonly shortLabel: string;
  readonly enabled: boolean;
  readonly shrink?: boolean;
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
              shrink ? "min-w-0 shrink" : "shrink-0",
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
  // Removing the issue chip opts out of the launch, so the hint goes with it.
  const launch = useComposerDraftStore((state) =>
    attachedLinearDraftIssue(
      state.getDraftThread(draftTarget)?.linearIssue,
      state.getComposerDraft(draftTarget)?.linearContexts ?? [],
    ),
  );
  const setDraftLinearIssue = useComposerDraftStore((state) => state.setDraftLinearIssue);
  if (launch === null) return null;
  const moveLabel = linearMoveHint(launch);
  return (
    <div
      data-chat-composer-linear-hint="true"
      className="flex min-w-0 max-w-80 shrink items-center gap-1 overflow-hidden text-xs text-muted-foreground"
    >
      {moveLabel !== null && launch.moveTo ? (
        <>
          <HintToggle
            label={moveLabel}
            shortLabel={`→ ${launch.moveTo.name}`}
            enabled={launch.moveEnabled}
            shrink
            onToggle={() =>
              setDraftLinearIssue(draftTarget, { ...launch, moveEnabled: !launch.moveEnabled })
            }
          />
          <span aria-hidden className="shrink-0">
            ·
          </span>
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
