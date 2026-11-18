import type { OrchestrationMessageContext } from "@t3tools/contracts";
import { withOneShotContext } from "@t3tools/shared/forkOneShot";
import { T, useGT } from "gt-react";
import { CircleCheckBigIcon } from "lucide-react";
import { create } from "zustand";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";

/**
 * Fork: the composer's "One-shot" toggle for a new thread's first message. Keyed by draft id, so
 * it lives exactly as long as the draft; a sent draft becomes a server thread and the key is gone.
 */
const useOneShotDrafts = create<{ readonly draftIds: ReadonlySet<string> }>(() => ({
  draftIds: new Set(),
}));

function toggle(draftId: string) {
  useOneShotDrafts.setState(({ draftIds }) => {
    const next = new Set(draftIds);
    if (!next.delete(draftId)) next.add(draftId);
    return { draftIds: next };
  });
}

function useOneShot(draftId: string | null): boolean {
  return useOneShotDrafts((state) => draftId !== null && state.draftIds.has(draftId));
}

/** Adds the one-shot record when the draft being sent has the toggle on. */
export function withDraftOneShotContext(
  draftId: string | null,
  context: OrchestrationMessageContext | undefined,
): OrchestrationMessageContext | undefined {
  return draftId !== null && useOneShotDrafts.getState().draftIds.has(draftId)
    ? withOneShotContext(context)
    : context;
}

export function ForkOneShotToggle(props: { draftId: string | null; size: ComposerControlSize }) {
  const gt = useGT();
  const enabled = useOneShot(props.draftId);
  const { draftId } = props;
  if (draftId === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size={props.size}
            type="button"
            aria-pressed={enabled}
            aria-label={gt("One-shot", { $context: "composer toggle" })}
            onClick={() => toggle(draftId)}
          />
        }
      >
        <ComposerControlIcon icon={CircleCheckBigIcon} size={props.size} />
        <span data-composer-control-label className="sr-only sm:not-sr-only">
          <T context="composer toggle">One-shot</T>
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {gt(
          "Settle this thread when the agent finishes. The agent is told no follow-ups will come.",
        )}
      </TooltipPopup>
    </Tooltip>
  );
}
