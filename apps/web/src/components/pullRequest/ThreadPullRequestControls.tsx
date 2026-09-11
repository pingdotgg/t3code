import { requestOlderThreadTurns } from "@t3tools/client-runtime/state/threads";
import * as Option from "effect/Option";
import { useEnvironmentThread } from "~/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, GitPullRequestIcon, Link2, PlusIcon } from "lucide-react";
import { useMemo, useState, type ComponentProps } from "react";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { useProject, useThreadShell } from "~/state/entities";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
} from "../ui/menu";
import { threadPullRequestSuggestions } from "./threadPullRequestSuggestions";
import { openLinkPullRequestDialog } from "./LinkPullRequestDialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadPullRequestBadgeControl } from "../ThreadStatusIndicators";

type ThreadPullRequestControlsProps = ComponentProps<typeof ThreadPullRequestBadgeControl> & {
  threadRef: ScopedThreadRef;
  active: boolean;
};

export function ThreadPullRequestControls(props: ThreadPullRequestControlsProps) {
  const { threadRef } = props;
  const linking = usePullRequestLinking(threadRef.environmentId);
  return linking.mode === "multiple" ? (
    <ThreadPullRequestLinkMenu {...props} />
  ) : (
    <ThreadPullRequestBadgeControl {...props} />
  );
}

function ThreadPullRequestLinkMenu({
  threadRef,
  active,
  ...badgeProps
}: ThreadPullRequestControlsProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const thread = useThreadShell(threadRef);
  const readHistory = thread !== null && (active || open);
  const history = useEnvironmentThread(
    readHistory ? threadRef.environmentId : null,
    readHistory ? threadRef.threadId : null,
  );
  const detail = Option.getOrNull(history.data);
  const page = Option.getOrNull(history.page);
  const cursor = page?.hasMore ? page.beforeCursor : null;
  const project = useProject(
    thread ? { environmentId: threadRef.environmentId, projectId: thread.projectId } : null,
  );
  const linking = usePullRequestLinking(threadRef.environmentId);
  const suggestions = useMemo(
    () =>
      thread === null
        ? []
        : threadPullRequestSuggestions(thread, detail?.messages ?? [], project?.repositoryIdentity),
    [detail?.messages, project?.repositoryIdentity, thread],
  );
  const unlinkedCount = suggestions.filter(
    (suggestion) => !linking.isLinked(thread, suggestion.url),
  ).length;
  if (thread === null) return <ThreadPullRequestBadgeControl {...badgeProps} />;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <ThreadPullRequestBadgeControl
        {...badgeProps}
        badge={
          unlinkedCount > 0 && suggestions.length > 1
            ? { kind: "pull-request", others: suggestions.length - 1, state: "open" }
            : badgeProps.badge
        }
        unlinkedCount={unlinkedCount}
        onOpenPullRequests={() => {
          if (unlinkedCount > 0) setOpen(true);
          else badgeProps.onOpenPullRequests();
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button size="icon-tiny" variant="ghost-muted" />}
              aria-label="Link PRs"
              onKeyDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <Link2 className="size-3" />
            </MenuTrigger>
          }
        />
        <TooltipPopup>Link PRs to keep with this thread</TooltipPopup>
      </Tooltip>
      <MenuPopup
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)]"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <MenuGroup>
          <MenuGroupLabel>PRs in this thread</MenuGroupLabel>
          {suggestions.map((suggestion) => {
            const linked = linking.isLinked(thread, suggestion.url);
            const saved = thread?.pullRequests.find((link) => link.url === suggestion.url);
            return (
              <MenuItem
                key={suggestion.url}
                closeOnClick={false}
                disabled={linked || pending !== null || !linking.canLink(suggestion.url)}
                aria-label={
                  linked ? `PR #${suggestion.number} linked` : `Link PR #${suggestion.number}`
                }
                onClick={async () => {
                  setPending(suggestion.url);
                  try {
                    await linking.changeLink(threadRef, suggestion.url, true);
                  } catch (error) {
                    toastManager.add({
                      type: "error",
                      title: "Could not link pull request",
                      description: error instanceof Error ? error.message : String(error),
                    });
                  } finally {
                    setPending(null);
                  }
                }}
              >
                <GitPullRequestIcon aria-hidden className="size-4" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">#{suggestion.number}</span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {saved?.snapshot?.title ?? suggestion.repository}
                  </span>
                </span>
                {linked ? (
                  <CheckIcon aria-hidden className="size-3.5" />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {pending === suggestion.url ? "Linking…" : "Link"}
                  </span>
                )}
              </MenuItem>
            );
          })}
          {open && (history.status === "empty" || history.status === "synchronizing") ? (
            <MenuGroupLabel>Loading thread PRs…</MenuGroupLabel>
          ) : suggestions.length === 0 ? (
            <MenuGroupLabel>No PR links found in this thread.</MenuGroupLabel>
          ) : null}
          {cursor !== null ? (
            <MenuItem
              disabled={page?.loadingOlder}
              closeOnClick={false}
              onClick={() => requestOlderThreadTurns(threadRef.environmentId, threadRef.threadId)}
            >
              {page?.loadingOlder ? "Looking for older PRs…" : "Look for older PRs"}
            </MenuItem>
          ) : null}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            setOpen(false);
            openLinkPullRequestDialog(threadRef);
          }}
        >
          <PlusIcon aria-hidden className="size-4" />
          Link PR by number…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
