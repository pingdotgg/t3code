import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import type {
  GitHubAccountRouting,
  GitHubAccountSelection,
  GitHubAuthAccount,
} from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

type RoutedAccount = GitHubAccountSelection & { readonly host: string };

function accountKey(account: RoutedAccount): string {
  return `${account.host.toLowerCase()}\n${account.login.toLowerCase()}\n${account.tokenSource}`;
}

function tokenSourceLabel(tokenSource: string): string {
  return tokenSource === "keyring" ? "GitHub CLI" : tokenSource;
}

function accountLabel(account: RoutedAccount, includeHost: boolean): string {
  return [
    account.login,
    ...(includeHost ? [account.host] : []),
    tokenSourceLabel(account.tokenSource),
  ].join(" · ");
}

function accountSelection(account: RoutedAccount): GitHubAccountSelection {
  return { login: account.login, tokenSource: account.tokenSource };
}

function routedAccount(host: string, account: GitHubAccountSelection): RoutedAccount {
  return { host, ...account };
}

export function hasMultipleGitHubAccountsOnHost(
  accounts: ReadonlyArray<GitHubAuthAccount>,
): boolean {
  return accounts.some(
    (account, index) =>
      accounts.findIndex(
        (candidate) => candidate.host.toLowerCase() === account.host.toLowerCase(),
      ) !== index,
  );
}

function GitHubAccountSelect({
  accounts,
  value,
  label,
  includeHost = false,
  onChange,
}: {
  readonly accounts: ReadonlyArray<RoutedAccount>;
  readonly value: RoutedAccount;
  readonly label: string;
  readonly includeHost?: boolean;
  readonly onChange: (account: RoutedAccount) => void;
}) {
  const selected = accounts.find((account) => accountKey(account) === accountKey(value)) ?? value;
  return (
    <Select
      value={accountKey(selected)}
      onValueChange={(key) => {
        const account = accounts.find((entry) => accountKey(entry) === key);
        if (account) onChange(account);
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-64" aria-label={label}>
        <SelectValue>{accountLabel(selected, includeHost)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {accounts.map((account) => (
          <SelectItem key={accountKey(account)} hideIndicator value={accountKey(account)}>
            {accountLabel(account, includeHost)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function GitHubAccountSettings({
  accounts,
}: {
  readonly accounts: ReadonlyArray<GitHubAuthAccount>;
}) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const routing = settings.githubAccountRouting;
  const [owner, setOwner] = useState("");
  const uniqueAccounts = [
    ...new Map(accounts.map((account) => [accountKey(account), account])).values(),
  ];
  const accountsByHost = new Map<string, GitHubAuthAccount[]>();
  for (const account of uniqueAccounts) {
    const host = account.host.toLowerCase();
    const held = accountsByHost.get(host);
    if (held === undefined) accountsByHost.set(host, [account]);
    else held.push(account);
  }
  const selectableHosts = [...accountsByHost.entries()].filter(
    ([, hostAccounts]) => hostAccounts.length > 1,
  );
  const selectableHostKeys = new Set(selectableHosts.map(([host]) => host));
  const hiddenDefaultHosts = Object.entries(routing)
    .filter(
      ([host, route]) =>
        route.defaultAccount !== undefined && !selectableHostKeys.has(host.toLowerCase()),
    )
    .map(([host]) => host);
  const selectableAccounts = selectableHosts.flatMap(([, hostAccounts]) => hostAccounts);
  const initialAccount =
    selectableAccounts.find((account) => account.active) ?? selectableAccounts[0];
  const [accountKeyValue, setAccountKeyValue] = useState(
    initialAccount === undefined ? "" : accountKey(initialAccount),
  );
  const hasSavedRouting = Object.keys(routing).length > 0;

  const updateHostRouting = (
    host: string,
    update: (current: GitHubAccountRouting[string]) => GitHubAccountRouting[string],
  ) => {
    const hostKey = host.toLowerCase();
    const nextRouting = { ...routing };
    const next = update(routing[hostKey] ?? { ownerOverrides: {} });
    if (next.defaultAccount === undefined && Object.keys(next.ownerOverrides).length === 0) {
      delete nextRouting[hostKey];
    } else {
      nextRouting[hostKey] = next;
    }
    updateSettings({ githubAccountRouting: nextRouting });
  };

  if (selectableAccounts.length === 0) {
    if (!hasSavedRouting) return null;
    return (
      <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-xs font-medium text-foreground">Saved account routing</div>
          <div className="text-xs text-muted-foreground">
            Multiple signed-in accounts are no longer available. Clear saved routing to use the
            active GitHub account.
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => updateSettings({ githubAccountRouting: {} })}
        >
          Clear saved routing
        </Button>
      </div>
    );
  }

  const normalizedOwner = owner.trim().replace(/^\/+|\/+$/g, "");
  const overrideAccount =
    selectableAccounts.find((entry) => accountKey(entry) === accountKeyValue) ??
    selectableAccounts[0]!;
  const canAddOverride = /^[A-Za-z0-9_.-]+$/.test(normalizedOwner);

  const addOverride = () => {
    if (!canAddOverride) return;
    updateHostRouting(overrideAccount.host, (current) => ({
      ...current,
      ownerOverrides: {
        ...current.ownerOverrides,
        [normalizedOwner.toLowerCase()]: accountSelection(overrideAccount),
      },
    }));
    setOwner("");
  };

  const savedOverrides = Object.entries(routing).flatMap(([host, route]) =>
    Object.entries(route.ownerOverrides).map(([ownerKey, account]) => ({
      host,
      owner: ownerKey,
      account,
    })),
  );

  return (
    <div className="grid gap-4 border-t border-border/60 pt-4">
      <div>
        <div className="text-sm font-medium text-foreground">GitHub accounts</div>
        <div className="text-xs text-muted-foreground">
          Choose the signed-in account T3 Code uses. Defaults apply to every repository on a host;
          owner overrides take precedence.
        </div>
      </div>
      {selectableHosts.map(([host, hostAccounts]) => {
        const active = hostAccounts.find((account) => account.active) ?? hostAccounts[0]!;
        const selected = routedAccount(host, routing[host]?.defaultAccount ?? active);
        return (
          <div
            key={host}
            className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <div className="text-xs font-medium text-foreground">Default for {host}</div>
              <div className="text-xs text-muted-foreground">
                Used unless a repository owner override matches.
              </div>
            </div>
            <GitHubAccountSelect
              accounts={hostAccounts}
              value={selected}
              label={`Default GitHub account for ${host}`}
              onChange={(account) =>
                updateHostRouting(host, (current) => ({
                  ...current,
                  defaultAccount: accountSelection(account),
                }))
              }
            />
          </div>
        );
      })}

      <div className="grid gap-2">
        <div>
          <div className="text-xs font-medium text-foreground">Repository owner overrides</div>
          <div className="text-xs text-muted-foreground">
            Use another account for every repository owned by an organization or user.
          </div>
        </div>
        {savedOverrides.map(({ host, owner: ownerKey, account }) => {
          const hostAccounts = accountsByHost.get(host.toLowerCase()) ?? [];
          const routeKey = `${host}/${ownerKey}`;
          return (
            <div key={routeKey} className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 truncate text-xs">{routeKey}</code>
              <GitHubAccountSelect
                accounts={hostAccounts}
                value={routedAccount(host, account)}
                label={`GitHub account for ${routeKey}`}
                onChange={(nextAccount) =>
                  updateHostRouting(host, (current) => ({
                    ...current,
                    ownerOverrides: {
                      ...current.ownerOverrides,
                      [ownerKey]: accountSelection(nextAccount),
                    },
                  }))
                }
              />
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove GitHub account override for ${routeKey}`}
                onClick={() =>
                  updateHostRouting(host, (current) => {
                    const ownerOverrides = { ...current.ownerOverrides };
                    delete ownerOverrides[ownerKey];
                    return { ...current, ownerOverrides };
                  })
                }
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          );
        })}
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            addOverride();
          }}
        >
          <Input
            size="sm"
            value={owner}
            onValueChange={setOwner}
            placeholder="Organization or user, e.g. acme-corp"
            aria-label="GitHub organization or user"
            className="flex-1"
          />
          <GitHubAccountSelect
            accounts={selectableAccounts}
            value={overrideAccount}
            label="GitHub account for new override"
            includeHost={selectableHosts.length > 1}
            onChange={(account) => setAccountKeyValue(accountKey(account))}
          />
          <Button size="sm" type="submit" disabled={!canAddOverride}>
            <PlusIcon className="size-3.5" />
            Add
          </Button>
        </form>
        {hiddenDefaultHosts.length > 0 ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium text-foreground">Unavailable saved defaults</div>
              <div className="text-xs text-muted-foreground">
                Saved defaults for {hiddenDefaultHosts.join(", ")} are no longer selectable.
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const next = { ...routing };
                for (const host of hiddenDefaultHosts) {
                  const route = next[host];
                  if (route === undefined) continue;
                  if (Object.keys(route.ownerOverrides).length === 0) delete next[host];
                  else next[host] = { ownerOverrides: route.ownerOverrides };
                }
                updateSettings({ githubAccountRouting: next });
              }}
            >
              Clear unavailable defaults
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
