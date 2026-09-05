import { LoaderCircleIcon } from "lucide-react";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import { ComposerBanner } from "./ComposerBanner";

export function ComposerActivityRow({ phase }: { readonly phase: ThreadSyncPhase }) {
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon ref={observeVisibleAnimation}>
        <LoaderCircleIcon className="motion-safe:visible-animate-spin" />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span
          className="shrink-0 whitespace-nowrap text-muted-foreground"
          data-composer-sync-status={phase}
          role="status"
        >
          {threadSyncLabel(phase)}
        </span>
      </ComposerBanner.Content>
    </ComposerBanner.Row>
  );
}
