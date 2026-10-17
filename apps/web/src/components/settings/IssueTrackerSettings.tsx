import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ExternalLinkIcon } from "lucide-react";
import { useState, type ChangeEvent, type ElementType } from "react";
import type {
  EnvironmentId,
  IssueTrackerConnection,
  IssueTrackerConnectionList,
  IssueTrackerProjectBinding,
  IssueTrackerScopePage,
  ProjectId,
} from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { issueTrackerEnvironment } from "../../state/issueTrackers";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { LinearIcon } from "../Icons";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import {
  connectFailureMessage,
  connectionFailureDetail,
  packCredential,
} from "./IssueTrackerSettings.logic";
import { SecretInput } from "./SecretInput";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type TrackerIcon = ElementType<{ className?: string }>;

/** Web art per tracker kind; the server supplies everything else about a tracker. */
const TRACKER_ICONS: Partial<Record<string, TrackerIcon>> = {
  linear: LinearIcon,
};

const UNBOUND = "";
const NEW_ACCOUNT = "new";

type ScopePages = Record<
  string,
  IssueTrackerScopePage & {
    readonly failure: string | null;
  }
>;

function accountKey(account: Pick<IssueTrackerConnection, "connectionId">) {
  return JSON.stringify(account.connectionId ?? null);
}

function accountLabel(account: IssueTrackerConnection) {
  return `${account.account ?? "Unverified account"} · ${account.host ?? account.displayName} · ${account.connectionId ?? "Default account"}`;
}

/**
 * Standalone issue trackers for one environment: connect each with a credential, and bind the
 * environment's projects to one of the tracker's scopes so their issues list beside the git
 * host's. Generic over the trackers the server reports; nothing here names Linear but its icon.
 */
export function IssueTrackerSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    issueTrackerEnvironment.connections({ environmentId, input: {} }),
  );
  const trackers = query.data?.trackers ?? [];
  if (query.data === null && query.isPending) {
    return (
      <SettingsSection id={searchableSetting("issue-trackers").id} title="Issue trackers">
        <div className="grid gap-3 px-4 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-full" />
        </div>
      </SettingsSection>
    );
  }
  if (query.data === null && query.error !== null) {
    return (
      <SettingsSection id={searchableSetting("issue-trackers").id} title="Issue trackers">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <p className="text-xs text-destructive">{query.error}</p>
          <Button size="xs" variant="outline" onClick={query.refresh}>
            Retry
          </Button>
        </div>
      </SettingsSection>
    );
  }
  if (trackers.length === 0) return null;
  return (
    <SettingsSection id={searchableSetting("issue-trackers").id} title="Issue trackers">
      {trackers.map((tracker) => (
        <TrackerRow
          key={`${tracker.tracker}-${environmentId}-${query.data?.accounts !== undefined && query.data?.projectBindings !== undefined}`}
          environmentId={environmentId}
          tracker={tracker}
          connections={query.data!}
        />
      ))}
    </SettingsSection>
  );
}

function TrackerRow({
  environmentId,
  tracker,
  connections,
}: {
  readonly environmentId: EnvironmentId;
  readonly tracker: IssueTrackerConnection;
  readonly connections: IssueTrackerConnectionList;
}) {
  const multipleAccounts =
    connections.accounts !== undefined && connections.projectBindings !== undefined;
  const accounts = multipleAccounts
    ? connections.accounts!.filter((account) => account.tracker === tracker.tracker)
    : tracker.connected
      ? [tracker]
      : [];
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const selected =
    selectedKey === null
      ? (accounts[0] ?? tracker)
      : accounts.find((account) => accountKey(account) === selectedKey);
  const unavailable = !adding && selected === undefined;
  const current = adding ? tracker : (selected ?? tracker);
  const draftKey = adding ? NEW_ACCOUNT : (selectedKey ?? accountKey(current));
  const Icon = TRACKER_ICONS[tracker.tracker];
  const canEdit = useAtomValue(issueTrackerEnvironment.connect.permissionAtom(environmentId));
  const connect = useAtomCommand(issueTrackerEnvironment.connect, {
    label: `connect ${tracker.displayName}`,
    reportFailure: false,
  });
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const draft = drafts[draftKey] ?? {};
  const setDraft = (value: Record<string, string>) =>
    setDrafts((current) => ({ ...current, [draftKey]: value }));
  const fields = current.credential.fields;
  const packed = packCredential(fields, draft);
  const inputId = `issue-tracker-${tracker.tracker}-${environmentId}`;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [scopeState, setScopeState] = useState<{
    catalog: IssueTrackerConnectionList;
    pages: ScopePages;
    pending: ReadonlySet<string>;
  }>({ catalog: connections, pages: {}, pending: new Set() });
  if (scopeState.catalog !== connections)
    setScopeState({ ...scopeState, catalog: connections, pages: {} });
  const scopePages = scopeState.catalog === connections ? scopeState.pages : {};
  const readScopes = useAtomQueryRunner(issueTrackerEnvironment.scopes, {
    reportFailure: false,
    refresh: true,
  });

  const loadMore = async (account: IssueTrackerConnection) => {
    const key = accountKey(account);
    const page = scopePages[key];
    const cursor = page === undefined ? account.scopesCursor : page.nextCursor;
    if (
      !multipleAccounts ||
      busy ||
      scopeState.pending.has(key) ||
      cursor == null ||
      !account.connected ||
      account.account === null
    )
      return;
    const pending = {
      items: page?.items ?? account.scopes,
      nextCursor: cursor,
      failure: null,
    };
    setScopeState((current) => ({
      catalog: connections,
      pages: { ...(current.catalog === connections ? current.pages : {}), [key]: pending },
      pending: new Set([...current.pending, key]),
    }));
    const result = await readScopes({
      environmentId,
      input: {
        tracker: tracker.tracker,
        ...(account.connectionId === undefined ? {} : { connectionId: account.connectionId }),
        cursor,
        limit: 100,
      },
    });
    setScopeState((current) => {
      const active = new Set(current.pending);
      active.delete(key);
      return current.catalog !== connections || current.pages[key] !== pending
        ? { ...current, pending: active }
        : {
            ...current,
            pending: active,
            pages: {
              ...current.pages,
              [key]: {
                ...pending,
                ...(result._tag === "Success"
                  ? {
                      items: [
                        ...new Map(
                          [...pending.items, ...result.value.items].map((scope) => [
                            scope.key,
                            scope,
                          ]),
                        ).values(),
                      ],
                      nextCursor: result.value.nextCursor,
                    }
                  : { failure: connectionFailureDetail(squashAtomCommandFailure(result)) }),
              },
            },
          };
    });
  };

  const submit = async (token: string | null) => {
    if (!canEdit || busy || unavailable) return;
    setBusy(true);
    setFailure(null);
    const result = await connect({
      environmentId,
      input: {
        tracker: tracker.tracker,
        token: multipleAccounts ? { value: token } : token,
        ...(adding
          ? { addAccount: true }
          : selected?.connectionId === undefined
            ? {}
            : { connectionId: selected.connectionId }),
      },
    }).finally(() => {
      setBusy(false);
    });
    if (result._tag === "Success") {
      setScopeState((current) => ({ ...current, pages: {} }));
      setDraft({});
      setAdding(false);
      return;
    }
    setFailure(connectFailureMessage(squashAtomCommandFailure(result)));
  };

  const status = unavailable ? (
    <Badge variant="outline">Account unavailable</Badge>
  ) : adding || !selected?.connected ? (
    <Badge variant="outline">Not connected</Badge>
  ) : selected.account === null ? (
    <Badge variant="destructive">Not verified</Badge>
  ) : (
    <Badge variant="secondary">Connected as {selected.account}</Badge>
  );

  return (
    <div className="first:rounded-t-xl last:rounded-b-xl">
      <div className="grid gap-3 px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {Icon ? <Icon className="size-4 shrink-0" /> : null}
            <span className="truncate text-sm font-medium text-foreground">
              {tracker.displayName}
            </span>
            {status}
          </div>
          <div className="flex gap-2">
            {multipleAccounts ? (
              <Button
                size="xs"
                variant="outline"
                disabled={!canEdit || busy || adding}
                onClick={() => {
                  setAdding(true);
                  setFailure(null);
                }}
              >
                Add account
              </Button>
            ) : null}
            {!adding && (selected?.connected || unavailable) ? (
              <Button
                size="xs"
                variant="outline"
                disabled={!canEdit || busy || unavailable}
                onClick={() => void submit(null)}
              >
                Disconnect
              </Button>
            ) : null}
          </div>
        </div>
        {multipleAccounts && (accounts.length > 0 || unavailable) ? (
          <Select
            value={adding ? NEW_ACCOUNT : (selectedKey ?? accountKey(current))}
            disabled={busy}
            onValueChange={(value) => {
              if (value === null || value === NEW_ACCOUNT || busy) return;
              setSelectedKey(value);
              setAdding(false);
              setFailure(null);
            }}
          >
            <SelectTrigger aria-label={`${tracker.displayName} account`} size="sm">
              <SelectValue>
                {adding ? "New account" : selected ? accountLabel(selected) : "Account unavailable"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {unavailable ? (
                <SelectItem value={selectedKey!} disabled>
                  Account unavailable
                </SelectItem>
              ) : null}
              {adding ? (
                <SelectItem value={NEW_ACCOUNT} disabled>
                  New account
                </SelectItem>
              ) : null}
              {accounts.map((account) => (
                <SelectItem key={accountKey(account)} value={accountKey(account)}>
                  {accountLabel(account)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        {!adding && selected?.detail ? (
          <p className="text-xs text-destructive">{selected.detail}</p>
        ) : null}
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (packed !== null) void submit(packed);
          }}
        >
          <fieldset disabled={!canEdit || busy || unavailable} className="contents">
            <div className="grid gap-1.5">
              <Label htmlFor={fields === undefined ? inputId : undefined}>
                {current.credential.label}
                {current.credential.helpUrl ? (
                  <>
                    {" · "}
                    <InlineButton
                      render={
                        <a
                          href={current.credential.helpUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        />
                      }
                    >
                      Create one
                      <ExternalLinkIcon aria-hidden className="size-3" />
                    </InlineButton>
                  </>
                ) : null}
              </Label>
              {fields?.map((field) => {
                const id = `${inputId}-${field.key}`;
                const props = {
                  id,
                  size: "sm" as const,
                  required: field.optional !== true,
                  value: draft[field.key] ?? "",
                  onChange: (event: ChangeEvent<HTMLInputElement>) =>
                    setDraft({ ...draft, [field.key]: event.target.value }),
                };
                return (
                  <div key={field.key} className="grid gap-1">
                    <Label htmlFor={id}>{field.label}</Label>
                    {field.secret ? (
                      <SecretInput
                        {...props}
                        configured={!adding && (selected?.connected ?? false)}
                      />
                    ) : (
                      <Input {...props} autoComplete="off" spellCheck={false} />
                    )}
                  </div>
                );
              })}
              <div className="flex gap-2">
                {fields === undefined ? (
                  <SecretInput
                    id={inputId}
                    size="sm"
                    configured={!adding && (selected?.connected ?? false)}
                    value={draft[""] ?? ""}
                    onChange={(event) => setDraft({ "": event.target.value })}
                  />
                ) : null}
                <Button
                  type="submit"
                  size="sm"
                  disabled={!canEdit || busy || unavailable || packed === null}
                >
                  {!adding && (selected?.connected || unavailable) ? "Replace" : "Connect"}
                </Button>
                {adding ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setAdding(false);
                      setFailure(null);
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </div>
          </fieldset>
          {failure ? (
            <p role="alert" className="text-xs text-destructive">
              {failure}
            </p>
          ) : null}
        </form>
        <ProjectBindings
          environmentId={environmentId}
          tracker={tracker}
          accounts={accounts.filter((account) => account.connected && account.account !== null)}
          connections={connections}
          multipleAccounts={multipleAccounts}
          scopePages={scopePages}
          pendingScopes={scopeState.pending}
          onLoadMore={loadMore}
          disabled={busy}
        />
      </div>
    </div>
  );
}

function ProjectBindings({
  environmentId,
  tracker,
  accounts,
  connections,
  multipleAccounts,
  scopePages,
  pendingScopes,
  onLoadMore,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly tracker: IssueTrackerConnection;
  readonly accounts: ReadonlyArray<IssueTrackerConnection>;
  readonly connections: IssueTrackerConnectionList;
  readonly multipleAccounts: boolean;
  readonly scopePages: ScopePages;
  readonly pendingScopes: ReadonlySet<string>;
  readonly onLoadMore: (account: IssueTrackerConnection) => Promise<void>;
  readonly disabled: boolean;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const bindingFor = (projectId: ProjectId) =>
    !multipleAccounts
      ? connections.bindings[projectId]?.tracker === tracker.tracker
        ? connections.bindings[projectId]
        : undefined
      : connections.projectBindings![projectId]?.find(
          (binding) => binding.tracker === tracker.tracker,
        );
  if (
    projects.length === 0 ||
    (accounts.length === 0 && !projects.some((project) => bindingFor(project.id)))
  )
    return null;

  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">
        Pick the {tracker.displayName} {tracker.scopeNoun} whose issues each project lists beside
        its repository's own.
      </p>
      <ul className="grid gap-1.5">
        {projects.map((project) => (
          <ProjectBindingRow
            key={project.id}
            environmentId={environmentId}
            tracker={tracker}
            accounts={accounts}
            multipleAccounts={multipleAccounts}
            scopePages={scopePages}
            pendingScopes={pendingScopes}
            onLoadMore={onLoadMore}
            projectId={project.id}
            projectTitle={project.title}
            binding={bindingFor(project.id)}
            disabled={disabled}
          />
        ))}
      </ul>
    </div>
  );
}

function ProjectBindingRow({
  environmentId,
  tracker,
  accounts,
  multipleAccounts,
  scopePages,
  pendingScopes,
  onLoadMore,
  projectId,
  projectTitle,
  binding,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly tracker: IssueTrackerConnection;
  readonly accounts: ReadonlyArray<IssueTrackerConnection>;
  readonly multipleAccounts: boolean;
  readonly scopePages: ScopePages;
  readonly pendingScopes: ReadonlySet<string>;
  readonly onLoadMore: (account: IssueTrackerConnection) => Promise<void>;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly binding: IssueTrackerProjectBinding | undefined;
  readonly disabled: boolean;
}) {
  const canBind = useAtomValue(issueTrackerEnvironment.bindProject.permissionAtom(environmentId));
  const bind = useAtomCommand(issueTrackerEnvironment.bindProject, {
    label: `bind project to ${tracker.displayName}`,
    reportFailure: false,
  });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected =
    selectedKey ??
    (binding ? accountKey(binding) : accounts[0] ? accountKey(accounts[0]) : UNBOUND);
  const account = accounts.find((account) => accountKey(account) === selected);
  const scopePage = scopePages[selected];
  const scopes = scopePage?.items ?? account?.scopes ?? [];
  const scopesCursor = scopePage === undefined ? account?.scopesCursor : scopePage.nextCursor;
  const value = binding && accountKey(binding) === selected ? binding.scope : UNBOUND;
  const [keys, setKeys] = useState<Record<string, string>>({});
  const key = keys[selected] ?? "";
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const locked = disabled || !canBind || busy;

  const change = async (scope: string) => {
    if (locked || (scope !== UNBOUND && !account)) return;
    setBusy(true);
    setFailure(null);
    const nextBinding =
      scope === UNBOUND
        ? null
        : {
            tracker: tracker.tracker,
            scope,
            ...(account?.connectionId === undefined ? {} : { connectionId: account.connectionId }),
          };
    const result = await bind({
      environmentId,
      input: {
        projectId,
        ...(scope === UNBOUND && multipleAccounts
          ? {
              tracker: tracker.tracker,
            }
          : {}),
        ...(multipleAccounts &&
        binding?.connectionId !== undefined &&
        (scope === UNBOUND || account?.connectionId === undefined)
          ? { connectionId: binding.connectionId }
          : {}),
        binding: multipleAccounts ? { value: nextBinding } : nextBinding,
      },
    }).finally(() => {
      setBusy(false);
    });
    if (result._tag === "Success") {
      setKeys((current) => ({ ...current, [selected]: "" }));
      return;
    }
    setFailure(connectionFailureDetail(squashAtomCommandFailure(result)));
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-3">
      <span className="min-w-0 truncate text-sm">{projectTitle}</span>
      <div className="flex flex-wrap gap-2">
        {multipleAccounts ? (
          <Select
            value={selected}
            disabled={locked}
            onValueChange={(next) => {
              if (next !== null && !locked) {
                setSelectedKey(next);
                setFailure(null);
              }
            }}
          >
            <SelectTrigger
              aria-label={`${tracker.displayName} account for ${projectTitle}`}
              className="w-48"
              size="sm"
            >
              <SelectValue>{account ? accountLabel(account) : "Account unavailable"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {!account ? (
                <SelectItem value={selected} disabled>
                  Account unavailable
                </SelectItem>
              ) : null}
              {accounts.map((account) => (
                <SelectItem key={accountKey(account)} value={accountKey(account)}>
                  {accountLabel(account)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <Select
          value={value}
          disabled={locked}
          onValueChange={(next) => {
            if (next !== null && next !== value) void change(next);
          }}
        >
          <SelectTrigger
            aria-label={`${tracker.displayName} ${tracker.scopeNoun} for ${projectTitle}`}
            className="w-48"
            size="sm"
          >
            <SelectValue>
              {value === UNBOUND
                ? "Not bound"
                : (scopes.find((scope) => scope.key === value)?.name ?? value)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={UNBOUND}>Not bound</SelectItem>
            {value !== UNBOUND && !scopes.some((scope) => scope.key === value) ? (
              <SelectItem value={value} disabled>
                {value}
              </SelectItem>
            ) : null}
            {scopes.map((scope) => (
              <SelectItem key={scope.key} value={scope.key}>
                {scope.name} ({scope.key})
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {multipleAccounts && account && scopesCursor != null ? (
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label={`Load more ${tracker.displayName} ${tracker.scopeNoun}s for ${projectTitle}`}
            disabled={disabled || pendingScopes.has(selected)}
            onClick={() => void onLoadMore(account)}
          >
            {pendingScopes.has(selected) ? "Loading" : `Load more ${tracker.scopeNoun}s`}
          </Button>
        ) : null}
      </div>
      {scopePage?.failure ? (
        <p role="alert" className="basis-full text-right text-xs text-destructive">
          {scopePage.failure}
        </p>
      ) : null}
      {account?.scopesTruncated ? (
        <form
          className="grid basis-full gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim()) void change(key.trim());
          }}
        >
          <p className="text-xs text-muted-foreground">
            Enter a {tracker.scopeNoun} key to bind one that is not listed.
          </p>
          <fieldset disabled={locked} className="flex justify-end gap-2">
            <Input
              aria-label={`${tracker.displayName} ${tracker.scopeNoun} key for ${projectTitle}`}
              className="w-48"
              size="sm"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder={`${tracker.scopeNoun} key`}
              value={key}
              onChange={(event) =>
                setKeys((current) => ({ ...current, [selected]: event.target.value }))
              }
            />
            <Button type="submit" size="sm" variant="outline" disabled={locked || !key.trim()}>
              Bind
            </Button>
          </fieldset>
        </form>
      ) : null}
      {failure ? (
        <p role="alert" className="basis-full text-right text-xs text-destructive">
          {failure}
        </p>
      ) : null}
    </li>
  );
}
