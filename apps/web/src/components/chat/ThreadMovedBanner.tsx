import type { OrchestrationV2ThreadMovedTo, ScopedThreadRef } from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import { ArrowRightLeftIcon } from "lucide-react";

import { useSideThreadTrigger } from "../../hooks/useSideThreadTrigger";
import { m, type MessageResolver } from "../../i18n/messages";
import { useLinkedThreadOpener } from "../../state/linkedThreadView";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

function OpenMovedThreadButton({
  threadRef,
  movedTo,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly movedTo: OrchestrationV2ThreadMovedTo;
}) {
  const gt = useGT();
  const opener = useLinkedThreadOpener(threadRef, movedTo, movedTo.title);
  const trigger = useSideThreadTrigger();
  if (opener === null) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      {...trigger(opener.open, { panel: opener.mode === "linked" })}
    >
      {gt("Open thread")}
    </Button>
  );
}

function KeepWorkingHereButton({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const clearMoved = useOrchestrationCommand(threadEnvironment.clearMoved, {
    reportFailure: false,
  });
  const keepWorkingHere = async () => {
    const result = await clearMoved({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: gt("Could not remove the Moved note") });
    }
  };
  return (
    <Button size="xs" variant="ghost" onClick={() => void keepWorkingHere()}>
      {gt("Keep working here")}
    </Button>
  );
}

/** Shown on a thread that continued on another machine, until work goes on here again. */
export function threadMovedBannerItem(
  input: {
    readonly threadRef: ScopedThreadRef;
    readonly movedTo: OrchestrationV2ThreadMovedTo;
  },
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  const { threadRef, movedTo } = input;
  return {
    id: "thread-moved",
    variant: "info",
    group: "environment",
    icon: <ArrowRightLeftIcon />,
    title: resolve(msg("Moved to {machine}", { machine: movedTo.label })),
    description: movedTo.title,
    actions: (
      <>
        <OpenMovedThreadButton threadRef={threadRef} movedTo={movedTo} />
        <KeepWorkingHereButton threadRef={threadRef} />
      </>
    ),
  };
}
