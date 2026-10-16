import { useAtomValue } from "@effect/atom-react";
import {
  gitHubOwnersOnHost,
  gitHubRepositoryOf,
  groupGitHubAccounts,
  nextGitHubHosts,
  nextGitHubRules,
  type GitHubHostGroup,
} from "@t3tools/client-runtime/github-accounts";
import { readGitHubSettings } from "@t3tools/client-runtime/source-control-clients";
import { AuthSettingsWriteScope, type ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { environmentProjects } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

/**
 * Which `gh` login reads each GitHub host, and each repository owner on it, for the selected
 * environments. The logins are the server's own, so only a host signed in more than once has a
 * choice to make here.
 */
export function SettingsGitHubAccountsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="GitHub accounts" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.length === 0 ? (
            <Text className="text-foreground-muted">Select a connected environment.</Text>
          ) : (
            selectedTargets.map((environment) => (
              <EnvironmentGitHubAccounts
                key={environment.environmentId}
                environment={environment}
                labelled={selectedTargets.length > 1}
              />
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

/**
 * One environment's GitHub logins and account choices, and how to change them: the hosts its
 * `gh` holds more than one working login for, and a save that replaces one host's choices.
 */
function useGitHubAccountChoices(environment: SettingsTarget) {
  const environmentId = environment.environmentId;
  const discovery = useEnvironmentQuery(
    sourceControlEnvironment.discovery({ environmentId, input: {} }),
  );
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const writable = useEnvironmentsWithScope([environment], AuthSettingsWriteScope).has(
    environmentId,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save GitHub account settings",
    reportFailure: true,
  });
  const [saving, setSaving] = useState(false);
  const hosts = readGitHubSettings(environment.serverConfig.settings).hosts;
  const github = discovery.data?.sourceControlProviders.find(
    (provider) => provider.kind === "github",
  );
  const groups = groupGitHubAccounts(github?.auth.accounts ?? []).filter(
    (group) => group.selectable.length > 1,
  );

  const save = async (host: string, change: Parameters<typeof nextGitHubHosts>[2]) => {
    if (saving) return;
    setSaving(true);
    try {
      await updateSettings({
        environmentId,
        input: {
          patch: {
            sourceControlHosts: { github: { hosts: nextGitHubHosts(hosts, host, change) } },
          },
        },
      });
    } finally {
      setSaving(false);
    }
  };
  return { discovery, github, projects, writable, saving, hosts, groups, save };
}

function EnvironmentGitHubAccounts({
  environment,
  labelled,
}: {
  readonly environment: SettingsTarget;
  readonly labelled: boolean;
}) {
  const { discovery, github, projects, writable, saving, hosts, groups, save } =
    useGitHubAccountChoices(environment);
  const identities = projects.map((project) => project.repositoryIdentity);
  const prefix = labelled ? `${environment.label} · ` : "";

  if (groups.length === 0) {
    return (
      <SettingsSection title={`${prefix}GitHub`}>
        <Text className="p-4 text-foreground-muted">
          {discovery.data === null
            ? "Checking which GitHub logins this server holds…"
            : "This server is signed in to one GitHub login per host. Run gh auth login on the server to add another."}
        </Text>
      </SettingsSection>
    );
  }

  return (
    <View className="gap-6">
      {groups.map((group) => (
        <HostAccounts
          key={group.host}
          group={group}
          prefix={prefix}
          choice={hosts[group.host]}
          owners={gitHubOwnersOnHost(group.host, identities, hosts[group.host]?.owners)}
          disabled={saving || !writable || hosts[group.host]?.enabled === false}
          onAccount={(account) => void save(group.host, { account })}
          onOwner={(owner, account) =>
            void save(group.host, {
              owners: nextGitHubRules(hosts[group.host]?.owners, owner, account),
            })
          }
          onRepository={(repository, account) =>
            void save(group.host, {
              repositories: nextGitHubRules(hosts[group.host]?.repositories, repository, account),
            })
          }
        />
      ))}
      {github?.auth.accounts?.some((account) => account.environmentVariable) ? (
        <Text className="px-2 text-sm text-foreground-muted">
          A GitHub token is set in the server's environment, so it overrides the accounts chosen
          here until it is unset.
        </Text>
      ) : null}
    </View>
  );
}

function HostAccounts(props: {
  readonly group: GitHubHostGroup;
  readonly prefix: string;
  readonly choice: ReturnType<typeof readGitHubSettings>["hosts"][string] | undefined;
  readonly owners: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onAccount: (account: string | null) => void;
  readonly onOwner: (owner: string, account: string | null) => void;
  readonly onRepository: (repository: string, account: string | null) => void;
}) {
  const { group, choice } = props;
  const pinned =
    choice?.account !== undefined && group.selectable.includes(choice.account)
      ? choice.account
      : null;
  // What an owner without a rule reads as: the host's pinned login, else gh's active one.
  const hostAccount = pinned ?? group.activeAccount;
  // Repositories a project gave a rule of its own, which wins over its owner's.
  const repositories = Object.keys(choice?.repositories ?? {}).sort((left, right) =>
    left.localeCompare(right),
  );
  return (
    <>
      <SettingsSection title={`${props.prefix}${group.host}`}>
        <AccountChoices
          accounts={group.selectable}
          selected={pinned}
          defaultLabel={`Active gh account${group.activeAccount ? ` (${group.activeAccount})` : ""}`}
          disabled={props.disabled}
          onSelect={props.onAccount}
        />
      </SettingsSection>
      {props.owners.map((owner) => (
        <SettingsSection key={owner} title={owner}>
          <AccountChoices
            accounts={group.selectable}
            selected={choice?.owners?.[owner] ?? null}
            defaultLabel={`Default${hostAccount ? ` (${hostAccount})` : ""}`}
            disabled={props.disabled}
            onSelect={(account) => props.onOwner(owner, account)}
          />
        </SettingsSection>
      ))}
      {repositories.map((repository) => {
        const ownerAccount = choice?.owners?.[repository.split("/")[0]!] ?? hostAccount;
        return (
          <SettingsSection key={repository} title={repository}>
            <AccountChoices
              accounts={group.selectable}
              selected={choice?.repositories?.[repository] ?? null}
              defaultLabel={`Owner's account${ownerAccount ? ` (${ownerAccount})` : ""}`}
              disabled={props.disabled}
              onSelect={(account) => props.onRepository(repository, account)}
            />
          </SettingsSection>
        );
      })}
      {props.owners.length > 0 ? (
        <Text className="px-2 text-sm text-foreground-muted">
          Each owner's repositories are read as the account chosen for it, and agents in its
          projects use it too. A project can choose one for its own repository in its settings.
        </Text>
      ) : null}
    </>
  );
}

/** The default first, then every login; `null` is the default. */
function AccountChoices(props: {
  readonly accounts: ReadonlyArray<string>;
  readonly selected: string | null;
  readonly defaultLabel: string;
  readonly disabled: boolean;
  readonly onSelect: (account: string | null) => void;
}) {
  const stale = props.selected !== null && !props.accounts.includes(props.selected);
  return (
    <>
      <SettingsChoiceRow
        label={props.defaultLabel}
        selected={props.selected === null || stale}
        disabled={props.disabled}
        onPress={() => props.onSelect(null)}
      />
      {props.accounts.map((account) => (
        <SettingsChoiceRow
          key={account}
          label={account}
          separated
          selected={props.selected === account}
          disabled={props.disabled}
          onPress={() => props.onSelect(account)}
        />
      ))}
    </>
  );
}

/**
 * The GitHub login one project's repository reads as, for a project selected in Settings: its
 * own rule, else its owner's. Only for a repository on a host the server holds more than one
 * login for; the rule is the repository's, so every checkout of it shares the choice.
 */
export function ProjectGitHubAccountSection({
  environment,
  projectId,
  labelled,
}: {
  readonly environment: SettingsTarget;
  readonly projectId: ProjectId;
  readonly labelled: boolean;
}) {
  const { projects, writable, saving, hosts, groups, save } = useGitHubAccountChoices(environment);
  const repository = gitHubRepositoryOf(
    projects.find((project) => project.id === projectId)?.repositoryIdentity,
  );
  const group =
    repository === null ? undefined : groups.find((entry) => entry.host === repository.host);
  if (repository === null || group === undefined) return null;

  const choice = hosts[repository.host];
  const owner = repository.repository.split("/")[0]!;
  const pinned =
    choice?.account !== undefined && group.selectable.includes(choice.account)
      ? choice.account
      : null;
  const ownerAccount = choice?.owners?.[owner] ?? pinned ?? group.activeAccount;
  return (
    <SettingsSection
      title={`${labelled ? `${environment.label} · ` : ""}GitHub account`}
      footer={`Pull requests in ${repository.repository} are read as this login, and agents in its projects use it. Owner's account follows the ${owner} rule under GitHub accounts.`}
    >
      <AccountChoices
        accounts={group.selectable}
        selected={choice?.repositories?.[repository.repository] ?? null}
        defaultLabel={`Owner's account${ownerAccount ? ` (${ownerAccount})` : ""}`}
        disabled={saving || !writable || choice?.enabled === false}
        onSelect={(account) =>
          void save(repository.host, {
            repositories: nextGitHubRules(choice?.repositories, repository.repository, account),
          })
        }
      />
    </SettingsSection>
  );
}
