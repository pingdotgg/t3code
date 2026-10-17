import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, SourceControlProviderAuth } from "@t3tools/contracts";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { environmentProjects } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  gitHubOwnersOnHost,
  gitHubRepositoryOf,
  groupGitHubAccounts,
  nextGitHubHosts,
  nextGitHubRules,
} from "@t3tools/client-runtime/github-accounts";
import { readGitHubSettings } from "@t3tools/client-runtime/source-control-clients";
import { redactedPlaceholder } from "./RedactedSensitiveText";
import { SettingsRow } from "./settingsLayout";

/** Sentinel select value for "follow the default"; logins never contain spaces. */
const DEFAULT_ACCOUNT = "default account";

function RedactedLogin(props: {
  readonly account: string;
  readonly revealed: boolean;
  readonly label?: string;
}) {
  return props.revealed ? (
    <span className="min-w-0 truncate font-mono text-2xs">{props.account}</span>
  ) : (
    <span className="min-w-0 truncate font-mono text-2xs">
      <span className="select-none blur-xs" aria-hidden>
        {redactedPlaceholder(props.account)}
      </span>
      <span className="sr-only">{props.label ?? "Hidden account"}</span>
    </span>
  );
}

/** Picks one of a host's logins, or the default the first option names. */
function AccountSelect(props: {
  readonly value: string;
  readonly accounts: ReadonlyArray<string>;
  readonly defaultLabel: ReactNode;
  readonly revealed: boolean;
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly onChange: (account: string | null) => void;
}) {
  return (
    <div className="w-64 max-w-full">
      <Select
        value={props.value}
        disabled={props.disabled}
        onValueChange={(value) => {
          if (typeof value !== "string") return;
          props.onChange(value === DEFAULT_ACCOUNT ? null : value);
        }}
      >
        <SelectTrigger size="sm" aria-label={props.ariaLabel}>
          <SelectValue>
            {(value: string) =>
              value === DEFAULT_ACCOUNT ? (
                props.defaultLabel
              ) : (
                <RedactedLogin revealed={props.revealed} account={value} />
              )
            }
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          <SelectItem value={DEFAULT_ACCOUNT}>{props.defaultLabel}</SelectItem>
          {props.accounts.map((account, index) => (
            <SelectItem key={account} value={account}>
              <RedactedLogin
                revealed={props.revealed}
                account={account}
                label={`Account ${index + 1}`}
              />
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/** "Default (login)": what a choice left on its default reads as. */
function DefaultLabel(props: {
  readonly prefix: string;
  readonly account: string | null;
  readonly revealed: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      {props.prefix}
      {props.account ? (
        <>
          (<RedactedLogin revealed={props.revealed} account={props.account} />)
        </>
      ) : null}
    </span>
  );
}

/** One owner's or repository's rule: its name, the login it reads as, and a stale warning. */
function AccountRuleRow(props: {
  readonly name: string;
  readonly rule: string | undefined;
  readonly accounts: ReadonlyArray<string>;
  readonly defaultLabel: ReactNode;
  readonly revealed: boolean;
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly staleWarning: string;
  readonly onChange: (account: string | null) => void;
}) {
  const stale = props.rule !== undefined && !props.accounts.includes(props.rule);
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate font-mono text-2xs text-foreground">{props.name}</span>
        <AccountSelect
          value={props.rule === undefined || stale ? DEFAULT_ACCOUNT : props.rule}
          accounts={props.accounts}
          defaultLabel={props.defaultLabel}
          revealed={props.revealed}
          disabled={props.disabled}
          ariaLabel={props.ariaLabel}
          onChange={props.onChange}
        />
      </div>
      {stale ? <p className="text-xs text-warning">{props.staleWarning}</p> : null}
    </div>
  );
}

export function GitHubAccountSettings({
  environmentId,
  auth,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly auth: SourceControlProviderAuth;
  readonly onSaved: () => void;
}) {
  const github = useEnvironmentSettings(environmentId, readGitHubSettings);
  const hosts = github.hosts;
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const identities = projects.map((project) => project.repositoryIdentity);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save GitHub account settings",
  });
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const groups = groupGitHubAccounts(auth.accounts ?? []);

  const save = async (host: string, change: Parameters<typeof nextGitHubHosts>[2]) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          sourceControlHosts: { github: { hosts: nextGitHubHosts(hosts, host, change) } },
        },
      },
    });
    setSaving(false);
    if (result._tag === "Success") onSaved();
  };

  if (groups.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Sign in with <code className="rounded bg-muted px-1 py-px text-2xs">gh auth login</code> on
        the server host, then rescan to choose accounts here.
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Choose which <code className="rounded bg-muted px-1 py-px text-2xs">gh</code> login each
          GitHub host uses, or turn a host off. With more than one login, pick one per repository
          owner; agents in that owner's projects use it too.
        </p>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          onClick={() => setRevealed((current) => !current)}
          aria-label={revealed ? "Hide GitHub accounts" : "Reveal GitHub accounts"}
          aria-pressed={revealed}
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      </div>
      {groups.map((group) => {
        const choice = hosts[group.host];
        const enabled = choice?.enabled ?? true;
        const stalePin =
          choice?.account !== undefined && !group.selectable.includes(choice.account);
        const pinned =
          choice?.account !== undefined && !stalePin ? choice.account : DEFAULT_ACCOUNT;
        const activeLabel = (
          <DefaultLabel
            prefix="Active gh account"
            account={group.activeAccount}
            revealed={revealed}
          />
        );
        // What an owner without a rule reads as: the host's pinned login, else gh's active one.
        const hostAccount = pinned === DEFAULT_ACCOUNT ? group.activeAccount : pinned;
        const multiple = group.selectable.length > 1;
        const owners = multiple ? gitHubOwnersOnHost(group.host, identities, choice?.owners) : [];
        const repositories = multiple
          ? Object.keys(choice?.repositories ?? {}).sort((left, right) => left.localeCompare(right))
          : [];
        return (
          <div key={group.host} className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <span className="text-xs font-medium text-foreground">{group.host}</span>
                {group.selectable.length === 1 && group.selectable[0] !== undefined ? (
                  <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <span>Signed in as</span>
                    <RedactedLogin revealed={revealed} account={group.selectable[0]} />
                  </p>
                ) : null}
              </div>
              <Switch
                checked={enabled}
                disabled={saving}
                aria-label={`Use GitHub on ${group.host}`}
                onCheckedChange={(checked) => void save(group.host, { enabled: checked })}
              />
            </div>
            {group.selectable.length > 1 ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">Account</span>
                <AccountSelect
                  value={pinned}
                  accounts={group.selectable}
                  defaultLabel={activeLabel}
                  revealed={revealed}
                  disabled={saving || !enabled}
                  ariaLabel={`GitHub account for ${group.host}`}
                  onChange={(account) => void save(group.host, { account })}
                />
              </div>
            ) : null}
            {stalePin ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-warning">
                  The chosen login is no longer signed in, so the active gh login is used.
                </p>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void save(group.host, { account: null })}
                >
                  Use active login
                </Button>
              </div>
            ) : null}
            {group.broken.map((entry) => (
              <p
                key={entry.account}
                className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground/70"
              >
                <RedactedLogin revealed={revealed} account={entry.account} />
                <span>can't be used: {entry.error ?? "gh reports this login as invalid."}</span>
              </p>
            ))}
            {owners.length > 0 ? (
              <div className="grid gap-2 border-l border-border pl-3">
                <span className="text-xs text-muted-foreground">Repository owners</span>
                {owners.map((owner) => (
                  <AccountRuleRow
                    key={owner}
                    name={owner}
                    rule={choice?.owners?.[owner]}
                    accounts={group.selectable}
                    defaultLabel={
                      <DefaultLabel prefix="Default" account={hostAccount} revealed={revealed} />
                    }
                    revealed={revealed}
                    disabled={saving || !enabled}
                    ariaLabel={`GitHub account for ${owner} on ${group.host}`}
                    staleWarning={`This login is no longer signed in, so ${owner} uses the default account.`}
                    onChange={(account) =>
                      void save(group.host, {
                        owners: nextGitHubRules(choice?.owners, owner, account),
                      })
                    }
                  />
                ))}
              </div>
            ) : null}
            {repositories.length > 0 ? (
              <div className="grid gap-2 border-l border-border pl-3">
                <span className="text-xs text-muted-foreground">Repositories</span>
                {repositories.map((repository) => (
                  <AccountRuleRow
                    key={repository}
                    name={repository}
                    rule={choice?.repositories?.[repository]}
                    accounts={group.selectable}
                    defaultLabel={
                      <DefaultLabel
                        prefix="Owner's account"
                        account={choice?.owners?.[repository.split("/")[0]!] ?? hostAccount}
                        revealed={revealed}
                      />
                    }
                    revealed={revealed}
                    disabled={saving || !enabled}
                    ariaLabel={`GitHub account for ${repository} on ${group.host}`}
                    staleWarning={`This login is no longer signed in, so ${repository} reads as its owner's account.`}
                    onChange={(account) =>
                      void save(group.host, {
                        repositories: nextGitHubRules(choice?.repositories, repository, account),
                      })
                    }
                  />
                ))}
              </div>
            ) : null}
            {group.environmentVariable ? (
              <p className="text-xs text-warning">
                {group.environmentVariable} is set on the server, so it overrides the accounts
                chosen here until it is unset.
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The GitHub login one project's repository reads as, at a project scope in Settings: its own
 * rule, else its owner's. Only for a repository on a host this environment's `gh` holds more than
 * one login for; the rule is the repository's, so every checkout of it shares the choice.
 */
export function ProjectGitHubAccountRow({
  environmentId,
  projectId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Names the environment when the scope spans several. */
  readonly environmentLabel: string | null;
}) {
  const discovery = useEnvironmentQuery(
    sourceControlEnvironment.discovery({ environmentId, input: {} }),
  );
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const hosts = useEnvironmentSettings(environmentId, readGitHubSettings).hosts;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save GitHub account settings",
  });
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const repository = gitHubRepositoryOf(
    projects.find((project) => project.id === projectId)?.repositoryIdentity,
  );
  const github = discovery.data?.sourceControlProviders.find(
    (provider) => provider.kind === "github",
  );
  const group =
    repository === null
      ? undefined
      : groupGitHubAccounts(github?.auth.accounts ?? []).find(
          (candidate) => candidate.host === repository.host,
        );
  if (repository === null || group === undefined || group.selectable.length < 2) return null;

  const choice = hosts[repository.host];
  const owner = repository.repository.split("/")[0]!;
  const pinned =
    choice?.account !== undefined && group.selectable.includes(choice.account)
      ? choice.account
      : null;
  const ownerAccount = choice?.owners?.[owner] ?? pinned ?? group.activeAccount;
  const rule = choice?.repositories?.[repository.repository];
  const stale = rule !== undefined && !group.selectable.includes(rule);
  const save = async (account: string | null) => {
    setSaving(true);
    try {
      await updateSettings({
        environmentId,
        input: {
          patch: {
            sourceControlHosts: {
              github: {
                hosts: nextGitHubHosts(hosts, repository.host, {
                  repositories: nextGitHubRules(
                    choice?.repositories,
                    repository.repository,
                    account,
                  ),
                }),
              },
            },
          },
        },
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRow
      id="project-github-account"
      title={environmentLabel ? `GitHub account · ${environmentLabel}` : "GitHub account"}
      description={
        stale
          ? "The chosen login is no longer signed in, so the owner's account is used."
          : `The login pull requests in ${repository.repository} are read as, and agents in its projects use. Owner's account follows the ${owner} rule in Source control settings.`
      }
      control={
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            onClick={() => setRevealed((current) => !current)}
            aria-label={revealed ? "Hide GitHub accounts" : "Reveal GitHub accounts"}
            aria-pressed={revealed}
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
          <AccountSelect
            value={rule === undefined || stale ? DEFAULT_ACCOUNT : rule}
            accounts={group.selectable}
            defaultLabel={
              <DefaultLabel prefix="Owner's account" account={ownerAccount} revealed={revealed} />
            }
            revealed={revealed}
            disabled={saving || choice?.enabled === false}
            ariaLabel={`GitHub account for ${repository.repository}`}
            onChange={(account) => void save(account)}
          />
        </div>
      }
    />
  );
}
