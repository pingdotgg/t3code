import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  BROWSER_PROFILE_MAX_COUNT,
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  type ClaudeArtifact,
  type ClaudeArtifactAccount,
  type ClaudeArtifactsSnapshot,
  type EnvironmentId,
  type ProviderInstanceId,
  resolveBrowserProfiles,
} from "@t3tools/contracts";
import { CopyIcon, ExternalLinkIcon, PinIcon, UsersIcon } from "lucide-react";
import { T, useGT, Var } from "gt-react";
import { useEffect, useEffectEvent, useState } from "react";

import { openUrlInPreview } from "~/browser/openFileInPreview";
import { RelativeTime } from "~/components/RelativeTime";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { PullRequestSearchInput } from "~/components/pullRequest/PullRequestListFilters";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { SidebarInset } from "~/components/ui/sidebar";
import { toastManager } from "~/components/ui/toast";
import { isElectron } from "~/env";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { persistClientSettingsUpdate } from "~/hooks/useSettings";
import { useStartBrowserThread } from "~/hooks/useStartBrowserThread";
import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { claudeArtifactsEnvironment } from "~/state/claudeArtifacts";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { artifactBrowserProfileId, filterArtifactAccounts } from "./ArtifactsPage.logic";

/** Environments this window already fetched for on open; later opens show the cache. */
const fetchedOnOpen = new Set<EnvironmentId>();

/** The account's own browser profile, registered on first use so its claude.ai login persists. */
async function ensureArtifactBrowserProfile(account: ClaudeArtifactAccount): Promise<string> {
  const profileId = artifactBrowserProfileId(account.instanceId);
  await persistClientSettingsUpdate((current) => {
    if (current.browserProfiles.some((profile) => profile.id === profileId)) return current;
    if (current.browserProfiles.length >= BROWSER_PROFILE_MAX_COUNT) {
      throw new Error("Browser profile limit reached.");
    }
    const taken = new Set(resolveBrowserProfiles(current.browserProfiles).map((p) => p.name));
    const base = account.displayName.slice(0, BROWSER_PROFILE_NAME_MAX_LENGTH - 3);
    let name = base;
    for (let index = 2; taken.has(name); index += 1) name = `${base} ${index}`;
    return {
      ...current,
      browserProfiles: [
        ...current.browserProfiles,
        { id: profileId, name, kind: "persistent" as const },
      ],
    };
  });
  return profileId;
}

export function ArtifactsPage() {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  const list = useEnvironmentQuery(
    environmentId === null ? null : claudeArtifactsEnvironment.list({ environmentId, input: {} }),
  );
  const canRefresh = useAtomValue(claudeArtifactsEnvironment.refresh.permissionAtom(environmentId));
  const runRefresh = useAtomCommand(claudeArtifactsEnvironment.refresh);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const startBrowserThread = useStartBrowserThread();
  const { copyToClipboard } = useCopyToClipboard({
    onCopy: () => toastManager.add({ type: "success", title: gt("Link copied") }),
  });
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [accountFilter, setAccountFilter] = useState<ProviderInstanceId | null>(null);

  const accounts = list.data?.accounts ?? [];
  const shown = filterArtifactAccounts(accounts, query, accountFilter);

  const refresh = async (instanceId?: ProviderInstanceId) => {
    if (environmentId === null) return;
    const keys: ReadonlyArray<string> =
      instanceId === undefined ? accounts.map((a) => a.instanceId) : [instanceId];
    setRefreshing((current) => new Set([...current, ...keys]));
    await runRefresh({ environmentId, input: instanceId === undefined ? {} : { instanceId } });
    setRefreshing((current) => new Set([...current].filter((key) => !keys.includes(key))));
    list.refresh();
  };

  const fetchOnOpen = useEffectEvent((snapshot: ClaudeArtifactsSnapshot) => {
    if (environmentId === null || !canRefresh || fetchedOnOpen.has(environmentId)) return;
    if (snapshot.accounts.length === 0) return;
    if (!snapshot.accounts.every((account) => account.status === "idle")) return;
    fetchedOnOpen.add(environmentId);
    void refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches from claude.ai once when the server has nothing cached
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the first fetch marks its accounts as fetching
    if (list.data !== null) fetchOnOpen(list.data);
  }, [list.data]);

  const openArtifact = async (account: ClaudeArtifactAccount, artifact: ClaudeArtifact) => {
    // claude.ai forbids framing, so only the desktop's own browser pane can show it in the app.
    if (!isPreviewSupportedInRuntime()) {
      void readLocalApi()?.shell.openExternal(artifact.url);
      return;
    }
    const fail = (description?: string) =>
      toastManager.add({
        type: "error",
        title: gt("Could not open the artifact"),
        ...(description === undefined ? {} : { description }),
      });
    let profileId: string;
    try {
      profileId = await ensureArtifactBrowserProfile(account);
    } catch (error) {
      fail(error instanceof Error ? error.message : undefined);
      return;
    }
    const threadRef = await startBrowserThread(gt("Could not open the artifact"), () => {});
    // Without a scratch thread to host the browser pane, the system browser still opens it.
    if (threadRef === null) {
      void readLocalApi()?.shell.openExternal(artifact.url);
      return;
    }
    const result = await openUrlInPreview({ threadRef, url: artifact.url, openPreview, profileId });
    if (result._tag === "Failure") {
      fail(thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined);
    }
  };

  const anyRefreshing = refreshing.size > 0;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel={gt("Artifacts breadcrumb")}>
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">
                <T context="page title, list of claude.ai artifacts">Artifacts</T>
              </h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>

        <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-48 flex-1">
                <PullRequestSearchInput
                  value={query}
                  label={gt("Search artifacts")}
                  placeholder={gt("Search artifacts")}
                  onChange={setQuery}
                  onSubmit={setQuery}
                />
              </div>
              {accounts.length > 1 ? (
                <AccountFilter
                  accounts={accounts}
                  value={accountFilter}
                  onChange={setAccountFilter}
                />
              ) : null}
              <Button
                variant="outline"
                disabled={!canRefresh || anyRefreshing || accounts.length === 0}
                onClick={() => void refresh()}
              >
                <RefreshIcon size="md" refreshing={anyRefreshing} />
                <T context="button that fetches the artifact lists again">Refresh</T>
              </Button>
            </div>

            {list.error !== null ? (
              <p className="text-destructive-foreground text-sm">{list.error}</p>
            ) : list.data !== null && accounts.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>
                    <T>No Claude accounts</T>
                  </EmptyTitle>
                  <EmptyDescription>
                    <T>Enable a Claude provider in Settings to list its claude.ai artifacts.</T>
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}

            {shown.map((account) => (
              <AccountSection
                key={account.instanceId}
                account={account}
                refreshing={refreshing.has(account.instanceId)}
                canRefresh={canRefresh && !refreshing.has(account.instanceId)}
                onRefresh={() => void refresh(account.instanceId)}
                onOpen={(artifact) => void openArtifact(account, artifact)}
                onOpenExternal={(artifact) => void readLocalApi()?.shell.openExternal(artifact.url)}
                onCopy={(artifact) => copyToClipboard(artifact.url, undefined)}
              />
            ))}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}

function AccountFilter({
  accounts,
  value,
  onChange,
}: {
  accounts: ReadonlyArray<ClaudeArtifactAccount>;
  value: ProviderInstanceId | null;
  onChange: (value: ProviderInstanceId | null) => void;
}) {
  const gt = useGT();
  const allLabel = gt("All accounts");
  const current = accounts.find((account) => account.instanceId === value)?.displayName ?? allLabel;
  return (
    <Menu>
      <MenuTrigger
        aria-label={gt("Filter by account: {current}", { current })}
        render={<Button variant="outline" />}
      >
        <UsersIcon aria-hidden />
        <span className="truncate">{current}</span>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup
          value={value ?? ""}
          onValueChange={(next) => onChange(next === "" ? null : (next as ProviderInstanceId))}
        >
          <MenuRadioItem value="">{allLabel}</MenuRadioItem>
          {accounts.map((account) => (
            <MenuRadioItem key={account.instanceId} value={account.instanceId}>
              {account.displayName}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function AccountStatus({
  account,
  refreshing,
}: {
  account: ClaudeArtifactAccount;
  refreshing: boolean;
}) {
  if (refreshing) {
    return (
      <span className="text-muted-foreground">
        <T context="status while fetching an account's artifacts">Fetching…</T>
      </span>
    );
  }
  if (account.fetchedAt === undefined) {
    return (
      <span className="text-muted-foreground">
        <T context="status of an account whose artifacts were never fetched">Not fetched yet</T>
      </span>
    );
  }
  const count = account.artifacts.length;
  return (
    <span className="text-muted-foreground">
      <T context="how many artifacts an account has, then when they were last fetched">
        <Var>{count}</Var> artifacts, fetched <RelativeTime timestamp={account.fetchedAt} />
      </T>
    </span>
  );
}

function AccountSection({
  account,
  refreshing,
  canRefresh,
  onRefresh,
  onOpen,
  onOpenExternal,
  onCopy,
}: {
  account: ClaudeArtifactAccount;
  refreshing: boolean;
  canRefresh: boolean;
  onRefresh: () => void;
  onOpen: (artifact: ClaudeArtifact) => void;
  onOpenExternal: (artifact: ClaudeArtifact) => void;
  onCopy: (artifact: ClaudeArtifact) => void;
}) {
  const gt = useGT();
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <h2 className="truncate font-medium">{account.displayName}</h2>
        <AccountStatus account={account} refreshing={refreshing} />
        <div className="flex-1" />
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label={gt("Refresh {account}", { account: account.displayName })}
          disabled={!canRefresh}
          onClick={onRefresh}
        >
          <RefreshIcon refreshing={refreshing} />
        </Button>
      </div>
      {account.status === "error" || account.status === "signedOut" ? (
        <p className="rounded-md bg-destructive/8 px-3 py-2 text-destructive-foreground text-sm">
          {account.status === "signedOut" ? (
            <T>This account is not signed in to claude.ai.</T>
          ) : null}{" "}
          {account.message}
        </p>
      ) : null}
      {account.partial ? (
        <p className="text-muted-foreground text-xs">
          <T>Claude Code listed only part of this account's artifacts.</T>
        </p>
      ) : null}
      {account.skippedLines > 0 ? (
        <p className="text-muted-foreground text-xs">
          <T>
            <Var>{account.skippedLines}</Var> list lines could not be read and are not shown.
          </T>
        </p>
      ) : null}
      {account.artifacts.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-lg border">
          {account.artifacts.map((artifact) => (
            <ArtifactRow
              key={artifact.url}
              artifact={artifact}
              onOpen={() => onOpen(artifact)}
              onOpenExternal={() => onOpenExternal(artifact)}
              onCopy={() => onCopy(artifact)}
            />
          ))}
        </ul>
      ) : account.status === "ok" ? (
        <p className="text-muted-foreground text-sm">
          <T>No artifacts match.</T>
        </p>
      ) : null}
    </section>
  );
}

function ArtifactRow({
  artifact,
  onOpen,
  onOpenExternal,
  onCopy,
}: {
  artifact: ClaudeArtifact;
  onOpen: () => void;
  onOpenExternal: () => void;
  onCopy: () => void;
}) {
  const gt = useGT();
  return (
    <li className="group flex min-w-0 items-center gap-2 px-3 py-2">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm outline-none focus-visible:underline"
        onClick={onOpen}
      >
        {artifact.pinned ? (
          <PinIcon aria-label={gt("Pinned")} className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <span aria-hidden className="size-3.5 shrink-0" />
        )}
        {/* Titles are third-party text: rendered as plain text only. */}
        <span className="min-w-0 truncate">{artifact.title}</span>
      </button>
      <Badge variant={artifact.owner === "mine" ? "secondary" : "outline"} size="sm">
        {artifact.owner === "mine" ? (
          <T context="an artifact the user published">Mine</T>
        ) : (
          <T context="an artifact someone shared with the user">Shared</T>
        )}
      </Badge>
      {artifact.kinds.map((kind) => (
        <Badge key={kind} variant="outline" size="sm" className="max-sm:hidden">
          {kind}
        </Badge>
      ))}
      {artifact.updatedOn === undefined ? null : (
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums max-sm:hidden">
          {artifact.updatedOn}
        </span>
      )}
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={gt("Open in browser")}
        onClick={onOpenExternal}
      >
        <ExternalLinkIcon />
      </Button>
      <Button size="icon-xs" variant="ghost-muted" aria-label={gt("Copy link")} onClick={onCopy}>
        <CopyIcon />
      </Button>
    </li>
  );
}
