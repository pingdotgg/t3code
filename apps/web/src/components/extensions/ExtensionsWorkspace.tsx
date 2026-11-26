// Fork: Kaluwa's Extensions page. The page itself, driven by props so it renders without a server.
import type { ExtensionsListResult, ExtensionsSubscription } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CheckIcon, LayoutGridIcon, LibraryIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { ExtensionsAddDialog } from "./ExtensionsAddDialog";
import { ExtensionsAllView } from "./ExtensionsAllView";
import { ExtensionsAttentionView } from "./ExtensionsAttentionView";
import {
  type ExtensionsAddPreset,
  ExtensionsContext,
  type ExtensionsContextValue,
  type ExtensionsView,
  useExtensions,
} from "./extensionsContext";
import { ExtensionsDetailPanel } from "./ExtensionsDetailPanel";
import { ExtensionsLibraryView } from "./ExtensionsLibraryView";
import {
  attentionCount,
  buildExtensionEntries,
  pendingKey,
  subscriptionHealthSummary,
} from "./extensionsModel";
import { SubscriptionIcon } from "./extensionsParts";
import { ExtensionsSubscriptionView } from "./ExtensionsSubscriptionView";

const NAV_ITEM_CLASS =
  "flex shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-start text-sm outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=page]:bg-accent md:w-full";

function NavItem({
  current,
  onClick,
  children,
}: {
  readonly current: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      className={NAV_ITEM_CLASS}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function NavLabel({ children }: { readonly children: ReactNode }) {
  return (
    <span className="px-2.5 pt-3 pb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase max-md:hidden">
      {children}
    </span>
  );
}

function SubscriptionNavItem({
  subscription,
  current,
}: {
  readonly subscription: ExtensionsSubscription;
  readonly current: boolean;
}) {
  const gt = useGT();
  const { openView } = useExtensions();
  const summary = subscriptionHealthSummary(subscription);
  const counts = [
    subscription.capabilities.mcp
      ? gt("{count} MCP", { count: subscription.mcpServers.length })
      : null,
    subscription.capabilities.plugins
      ? gt("{count, plural, one {{count} plugin} other {{count} plugins}}", {
          count: subscription.plugins.length,
        })
      : null,
    subscription.capabilities.skills
      ? gt("{count, plural, one {{count} skill} other {{count} skills}}", {
          count: subscription.skills.length,
        })
      : null,
  ].filter(Boolean);
  const clear = summary.failing + summary.needsAuth + summary.issues === 0;
  return (
    <NavItem
      current={current}
      onClick={() => openView({ page: "subscription", instanceId: subscription.instanceId })}
    >
      <SubscriptionIcon subscription={subscription} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium max-md:max-w-36">
            {subscription.displayName}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
            {clear ? (
              <CheckIcon
                className="size-3.5 text-success-foreground"
                aria-label={gt("Nothing needs attention")}
              />
            ) : null}
            {summary.failing > 0 ? (
              <span
                className="flex items-center gap-1 text-destructive-foreground"
                aria-label={gt("{count} failing", { count: summary.failing })}
              >
                <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
                {summary.failing}
              </span>
            ) : null}
            {summary.needsAuth + summary.issues > 0 ? (
              <span
                className="flex items-center gap-1 text-warning-foreground"
                aria-label={gt("{count} need attention", {
                  count: summary.needsAuth + summary.issues,
                })}
              >
                <span aria-hidden className="size-1.5 rounded-full bg-warning" />
                {summary.needsAuth + summary.issues}
              </span>
            ) : null}
          </span>
        </span>
        <span className="truncate text-xs text-muted-foreground max-md:hidden">
          {counts.join(" · ")}
        </span>
      </span>
    </NavItem>
  );
}

function ExtensionsNav({ view }: { readonly view: ExtensionsView }) {
  const gt = useGT();
  const { list, openView } = useExtensions();
  const attention = attentionCount(list);
  return (
    <nav
      aria-label={gt("Extensions sections")}
      className="flex shrink-0 gap-1 border-b p-2 max-md:overflow-x-auto md:w-60 md:flex-col md:overflow-y-auto md:border-e md:border-b-0"
    >
      <NavItem current={view.page === "all"} onClick={() => openView({ page: "all" })}>
        <LayoutGridIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 font-medium">
          <T>All subscriptions</T>
        </span>
      </NavItem>
      <NavItem current={view.page === "attention"} onClick={() => openView({ page: "attention" })}>
        <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 font-medium">
          <T>Needs attention</T>
        </span>
        <Badge variant={attention > 0 ? "warning" : "secondary"}>{attention}</Badge>
      </NavItem>
      <NavLabel>
        <T>Subscriptions</T>
      </NavLabel>
      {list.subscriptions.map((subscription) => (
        <SubscriptionNavItem
          key={subscription.instanceId}
          subscription={subscription}
          current={view.page === "subscription" && view.instanceId === subscription.instanceId}
        />
      ))}
      <NavLabel>
        <T>Shared</T>
      </NavLabel>
      <NavItem current={view.page === "library"} onClick={() => openView({ page: "library" })}>
        <LibraryIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 font-medium">
          <T>Skill library</T>
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {list.library.skills.length}
        </span>
      </NavItem>
      <p className="mt-auto px-2.5 pt-3 pb-1 text-xs text-muted-foreground max-md:hidden">
        <T>User-level extensions only. Project-scoped ones stay with each project.</T>
      </p>
    </nav>
  );
}

function ExtensionsSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 max-md:flex-col" aria-busy>
      <div className="flex shrink-0 gap-2 border-b p-3 md:w-60 md:flex-col md:border-e md:border-b-0">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-9 w-full max-md:w-32" shape="card" />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((card) => (
            <Skeleton key={card} className="h-24" shape="card" />
          ))}
        </div>
        <Skeleton className="h-64" shape="card" />
      </div>
    </div>
  );
}

export function ExtensionsWorkspace({
  list,
  loadError,
  canEdit,
  checking,
  checkFailed,
  pending,
  run,
  recheck,
  close,
}: {
  /** Null until the first list arrives. */
  readonly list: ExtensionsListResult | null;
  readonly loadError: string | null;
  readonly canEdit: boolean;
  readonly checking: boolean;
  readonly checkFailed: boolean;
  readonly pending: ReadonlySet<string>;
  readonly run: ExtensionsContextValue["run"];
  readonly recheck: () => void;
  readonly close: ReactNode;
}) {
  const gt = useGT();
  const [view, setView] = useState<ExtensionsView>({ page: "all" });
  const [search, setSearch] = useState("");
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [addPreset, setAddPreset] = useState<ExtensionsAddPreset | null>(null);
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);

  const entries = list === null ? [] : buildExtensionEntries(list);
  const subscription =
    view.page === "subscription"
      ? (list?.subscriptions.find((entry) => entry.instanceId === view.instanceId) ?? null)
      : null;
  const viewName =
    view.page === "attention"
      ? gt("Needs attention")
      : view.page === "library"
        ? gt("Skill library")
        : (subscription?.displayName ?? gt("All subscriptions"));

  const header = (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b py-1.5 ps-5 pe-2">
      <WorkspaceBreadcrumb ariaLabel={gt("Extensions breadcrumb")} className="min-w-0 flex-1">
        <WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbText>
            <T>Extensions</T>
          </WorkspaceBreadcrumbText>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current className="min-w-10">
          <WorkspaceBreadcrumbText>{viewName}</WorkspaceBreadcrumbText>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {list !== null ? (
        <>
          {checkFailed && !checking ? (
            <Badge variant="warning">
              <T>Health check failed</T>
            </Badge>
          ) : null}
          <div className="w-44 max-sm:hidden">
            <Input
              size="sm"
              type="search"
              value={search}
              aria-label={gt("Search extensions")}
              placeholder={gt("Search extensions")}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={gt("Check all")}
                  aria-busy={checking}
                  disabled={checking}
                  onClick={recheck}
                />
              }
            >
              <RefreshIcon size="sm" refreshing={checking} />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {checking
                ? gt("Checking every MCP server…")
                : gt("Check all: connect to every MCP server again")}
            </TooltipPopup>
          </Tooltip>
          <Button
            size="sm"
            onClick={() =>
              setAddPreset(subscription ? { instanceId: subscription.instanceId } : {})
            }
          >
            <PlusIcon />
            <span className="max-sm:sr-only">
              <T>Add extension</T>
            </span>
          </Button>
        </>
      ) : null}
      {close}
    </header>
  );

  if (list === null) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {header}
        {loadError !== null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm font-medium">
              <T>Couldn't load your extensions</T>
            </p>
            <p className="max-w-md wrap-anywhere text-sm text-muted-foreground">{loadError}</p>
            <Button size="sm" variant="outline" onClick={recheck}>
              <T>Try again</T>
            </Button>
          </div>
        ) : (
          <ExtensionsSkeleton />
        )}
      </div>
    );
  }

  const context: ExtensionsContextValue = {
    list,
    entries,
    search,
    canEdit,
    checking,
    isPending: (instanceId, key) => pending.has(pendingKey(instanceId, key)),
    run,
    recheck,
    openView: (next) => {
      setView(next);
      setDetailKey(null);
    },
    openDetail: setDetailKey,
    openAdd: (preset) => setAddPreset(preset ?? {}),
  };

  return (
    <ExtensionsContext value={context}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {header}
        <div ref={setPanelHost} className="relative flex min-h-0 flex-1 max-md:flex-col">
          <ExtensionsNav
            view={subscription === null && view.page === "subscription" ? { page: "all" } : view}
          />
          <ScrollArea className="min-h-0 min-w-0 flex-1" observeContent>
            <div className="mx-auto flex w-full max-w-5xl flex-col px-5 pt-6 pb-12 sm:px-6">
              {list.subscriptions.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-16 text-center">
                  <p className="text-sm font-medium">
                    <T>No subscriptions yet</T>
                  </p>
                  <p className="max-w-md text-sm text-muted-foreground">
                    <T>
                      Add a provider in Settings first. Its MCP servers, plugins and skills show up
                      here.
                    </T>
                  </p>
                </div>
              ) : subscription !== null ? (
                <ExtensionsSubscriptionView
                  key={subscription.instanceId}
                  subscription={subscription}
                />
              ) : view.page === "attention" ? (
                <ExtensionsAttentionView />
              ) : view.page === "library" ? (
                <ExtensionsLibraryView />
              ) : (
                <ExtensionsAllView />
              )}
            </div>
          </ScrollArea>
          <ExtensionsDetailPanel
            entry={entries.find((entry) => entry.key === detailKey) ?? null}
            container={panelHost}
            onClose={() => setDetailKey(null)}
          />
        </div>
      </div>
      {addPreset !== null ? (
        <ExtensionsAddDialog preset={addPreset} onClose={() => setAddPreset(null)} />
      ) : null}
    </ExtensionsContext>
  );
}
