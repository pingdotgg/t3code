import { parseScopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, XIcon } from "lucide-react";

import { isElectron } from "../env";
import { useClientSettings } from "../hooks/useSettings";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { cn } from "../lib/utils";
import { useDelegatedUnderParent, useProject, useQuietThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { useThreadTabsStore } from "../threadTabsStore";
import { useUiStateStore } from "../uiStateStore";
import { ProjectFavicon } from "./ProjectFavicon";
import { resolveThreadTabs, type ThreadTab } from "./ThreadTabStrip.logic";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Labs: the header's + that keeps the open thread as a tab. Hidden once it is one. */
export function ThreadTabAddButton({ threadKey }: { threadKey: string }) {
  const enabled = useClientSettings((settings) => settings.threadTabsEnabled);
  const added = useThreadTabsStore((store) => store.keys.includes(threadKey));
  const addTab = useThreadTabsStore((store) => store.add);
  if (!enabled || added) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Add as tab"
            data-thread-tab-add
            onClick={() => addTab(threadKey)}
          />
        }
      >
        <PlusIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Add as tab</TooltipPopup>
    </Tooltip>
  );
}

/** Labs: Chrome-style thread tabs under the chat header, shown once there is a tab. */
export function ThreadTabStrip({ activeThreadKey }: { activeThreadKey: string | null }) {
  const enabled = useClientSettings((settings) => settings.threadTabsEnabled);
  if (!enabled) return null;
  return <ThreadTabStripContent activeThreadKey={activeThreadKey} />;
}

function ThreadTabStripContent({ activeThreadKey }: { activeThreadKey: string | null }) {
  const navigate = useNavigate();
  const autoAddWorking = useClientSettings((settings) => settings.threadTabsAutoAddWorking);
  const tabKeys = useThreadTabsStore((store) => store.keys);
  const removeTab = useThreadTabsStore((store) => store.remove);
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const localLastVisitedAtByKey = useUiStateStore((store) => store.threadLastVisitedAtById);
  const tabs = resolveThreadTabs({
    tabKeys,
    threads,
    delegatedUnderParent,
    localLastVisitedAtByKey,
    autoAddWorking,
  });
  if (tabs.length === 0) return null;

  const openTab = (key: string) => {
    const ref = parseScopedThreadKey(key);
    if (ref === null || key === activeThreadKey) return;
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };

  return (
    <nav
      aria-label="Thread tabs"
      data-thread-tabs
      className={cn(
        "flex h-7 shrink-0 items-start gap-1 overflow-x-auto bg-background [scrollbar-width:none]",
        isElectron ? "px-3 sm:px-5" : "pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      {tabs.map((tab) => (
        <ThreadTabItem
          key={tab.key}
          tab={tab}
          active={tab.key === activeThreadKey}
          onOpen={() => openTab(tab.key)}
          onClose={() => removeTab(tab.key)}
        />
      ))}
    </nav>
  );
}

function ThreadTabItem({
  tab,
  active,
  onOpen,
  onClose,
}: {
  tab: ThreadTab;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const project = useProject(scopeProjectRef(tab.thread.environmentId, tab.thread.projectId));
  const label = tab.status ? `${tab.thread.title} · ${tab.status.label}` : tab.thread.title;
  // Closable tabs always reserve room for the close button, so revealing it on hover never
  // resizes the tab or shifts its neighbours.
  const closable = !tab.auto;
  const closeOnHover = closable && !active;
  return (
    <div
      data-thread-tab
      data-active={active ? "" : undefined}
      className={cn(
        "group/tab relative flex h-6 max-w-60 min-w-0 shrink-0 items-center rounded-md text-xs first:-ms-2",
        active
          ? "text-(--contrast-toolbar-foreground)"
          : cn(
              "hover:text-(--contrast-toolbar-foreground)/85",
              tab.auto
                ? "text-(--contrast-toolbar-foreground)/60"
                : "text-(--contrast-toolbar-foreground)/70",
            ),
        tab.auto && "italic",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-full min-w-0 items-center gap-1.5 rounded-md pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                closable ? "pr-5.5" : "pr-2",
              )}
              onClick={onOpen}
              onAuxClick={(event) => {
                if (event.button === 1 && closable) onClose();
              }}
            />
          }
        >
          {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
          <span className="min-w-0 truncate text-left">{tab.thread.title}</span>
          {tab.status ? (
            <span
              aria-hidden
              className={cn(
                "ms-0.5 size-1.5 shrink-0 rounded-full",
                tab.status.dotClass,
                tab.status.pulse && "motion-safe:animate-status-pulse",
              )}
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {tab.auto ? `${label}. Goes away once it is done and you have seen it.` : label}
        </TooltipPopup>
      </Tooltip>
      {closable ? (
        <span
          className={cn(
            "absolute inset-y-0 right-0.5 flex items-center",
            closeOnHover &&
              "opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100",
          )}
        >
          <Button
            variant="ghost-muted"
            size="icon-tiny"
            aria-label={`Close tab ${tab.thread.title}`}
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </span>
      ) : null}
    </div>
  );
}
