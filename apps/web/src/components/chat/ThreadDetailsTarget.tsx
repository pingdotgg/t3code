import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { GlobeIcon, RotateCcwIcon } from "lucide-react";

import { openUrlInPreview } from "../../browser/openFileInPreview";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import { previewStateAtom, type ThreadPreviewState } from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { readEnvironmentSupportsServerBrowser } from "../../state/entities";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";
import { selectTargetSession, targetSessionUrl } from "./threadDetailsTarget.logic";

interface ThreadDetailsTargetProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const lastSeenUrl = (state: ThreadPreviewState) => state.recentlySeenUrls[0] ?? null;

function urlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

/** Same reveal as an agent-opened tab: its panel tab, else the floating browser. */
function focusBrowserTab(threadRef: ScopedThreadRef, tabId: string): void {
  const panel = useRightPanelStore.getState();
  const surface = panel.byThreadKey[scopedThreadKey(threadRef)]?.surfaces.find(
    (entry) => entry.kind === "preview" && entry.resourceId === tabId,
  );
  if (surface) {
    panel.activateSurface(threadRef, surface.id);
  } else if (readEnvironmentSupportsServerBrowser(threadRef.environmentId)) {
    usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource(tabId));
  } else {
    panel.openBrowser(threadRef, tabId);
  }
}

/** The site under test: the URL of the thread's browser tab. */
export function ThreadDetailsTarget(props: ThreadDetailsTargetProps) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const atom = previewStateAtom(scopedThreadKey(threadRef));
  const session = useAtomValue(atom, selectTargetSession);
  const closedUrl = useAtomValue(atom, lastSeenUrl);
  const canOpen = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });

  const reopen = async (url: string) => {
    const result = await openUrlInPreview({ threadRef, url, openPreview });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to reopen site",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const sessionUrl = session ? targetSessionUrl(session) : null;
  const url = sessionUrl ?? closedUrl;

  return (
    <ThreadDetailsSection headingId="thread-details-target-heading" title="Target">
      {url === null && session === null ? (
        <p
          className={`m-0 py-1.5 text-xs text-muted-foreground ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS}`}
        >
          No site opened yet
        </p>
      ) : (
        <Tooltip>
          <TooltipTrigger
            delay={200}
            render={
              <ThreadDetailsControl
                size="sm"
                variant="ghost"
                part="row"
                multiline
                disabled={session === null && !canOpen}
                onClick={() => {
                  if (session) focusBrowserTab(threadRef, session.tabId);
                  else if (url !== null) void reopen(url);
                }}
              />
            }
          >
            {session ? (
              <GlobeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            ) : (
              <RotateCcwIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            )}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium leading-4 text-foreground/85">
                {url === null ? "New tab" : urlLabel(url)}
              </span>
              <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
                {session ? "Browser tab open" : "Tab closed · reopen"}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipPopup side="left">
            {session ? "Show the browser tab" : "Reopen this site in the browser panel"}
          </TooltipPopup>
        </Tooltip>
      )}
    </ThreadDetailsSection>
  );
}
