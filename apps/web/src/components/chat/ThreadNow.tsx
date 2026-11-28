import { CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useMessages } from "gt-react";

import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import {
  ComposerBanner,
  composerBannerDetailClassName,
  composerBannerTitleClassName,
} from "./ComposerBanner";

const FADE_IN =
  "transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none";

/** A line of thread state above the composer. */
export interface ThreadNowItem {
  readonly id: string;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}

/** One line of thread state above the composer: icon, title, detail, then actions. */
function ThreadNowLine({
  item,
  announce = false,
}: {
  readonly item: ThreadNowItem;
  /** Announces the line when it appears; only for something that needs the user. */
  readonly announce?: boolean;
}) {
  return (
    <ComposerBanner.Root
      role={announce ? "alert" : undefined}
      className={FADE_IN}
      data-thread-now-line="true"
    >
      <ComposerBanner.Row>
        <ComposerBanner.Icon>{item.icon}</ComposerBanner.Icon>
        <ComposerBanner.Content>
          <span className={composerBannerTitleClassName}>{item.title}</span>
          {item.description ? (
            <span className={composerBannerDetailClassName}>{item.description}</span>
          ) : null}
        </ComposerBanner.Content>
        {item.actions ? (
          <ComposerBanner.Actions className="text-dim-foreground tabular-nums">
            {item.actions}
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
}

function ThreadSyncLine({ phase }: { readonly phase: ThreadSyncPhase }) {
  const m = useMessages();
  return (
    <ComposerBanner.Root
      className={FADE_IN}
      role={phase === "failed" ? "alert" : "status"}
      data-composer-sync-status={phase}
    >
      <ComposerBanner.Row>
        <ComposerBanner.Icon>
          {phase === "failed" ? <CircleAlertIcon /> : <RefreshCwIcon />}
        </ComposerBanner.Icon>
        <ComposerBanner.Content>
          <span className={composerBannerTitleClassName}>{threadSyncLabel(phase, m)}</span>
        </ComposerBanner.Content>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
}

/**
 * What the thread is doing now, above the composer: what needs you, background work, the sync
 * status while messages load, then the goal.
 */
export function ThreadNow({
  attention,
  work,
  syncPhase,
  goal,
}: {
  /** Something that needs you elsewhere, such as a subagent's question. */
  readonly attention: ThreadNowItem | null;
  readonly work: ThreadNowItem | null;
  readonly syncPhase: ThreadSyncPhase | null;
  readonly goal: ThreadNowItem | null;
}): ReactNode {
  return (
    <>
      {attention ? <ThreadNowLine item={attention} announce /> : null}
      {work ? <ThreadNowLine item={work} /> : null}
      {syncPhase ? <ThreadSyncLine phase={syncPhase} /> : null}
      {goal ? <ThreadNowLine item={goal} /> : null}
    </>
  );
}
