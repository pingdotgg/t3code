import type { GitHubAccountRule, SourceControlDiscoveryResult } from "@lathe/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  accountOptions,
  addRule,
  moveRule,
  removeRule,
  updateRule,
  validateOwnerPattern,
  type GitHubAccountOption,
} from "./gitHubAccountRules.logic";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useUpdateScopedSettingsOn } from "./useScopedSettings";

const DEFAULT_HOST = "github.com";

function AccountSelect({
  value,
  accounts,
  label,
  onChange,
}: {
  readonly value: string;
  readonly accounts: ReadonlyArray<GitHubAccountOption>;
  readonly label: string;
  readonly onChange: (login: string) => void;
}) {
  const known = accounts.some((account) => account.login === value);
  return (
    <Select value={value} onValueChange={(next) => next !== null && onChange(next)}>
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{value}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {accounts.map((account) => (
          <SelectItem key={account.login} value={account.login}>
            {account.active ? `${account.login} (active)` : account.login}
          </SelectItem>
        ))}
        {known ? null : <SelectItem value={value}>{`${value} (not signed in)`}</SelectItem>}
      </SelectPopup>
    </Select>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

const joinLabels = (labels: ReadonlyArray<string>) => labels.join(", ");

/**
 * Environment-wide owner rules that pick a `gh` account per repository. "All environments" edits
 * every connected machine that supports them and one selected machine edits only itself, which is
 * how a machine gets its own rules. Projects choose an account on the project row, so nothing
 * renders at project scope.
 */
export function GitHubAccountRulesSettings({
  discovery,
}: {
  readonly discovery: SourceControlDiscoveryResult;
}) {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const supported = connectedEnvironments.filter(
    (candidate) => candidate.serverConfig?.environment.capabilities.gitHubAccountRouting === true,
  );
  const unsupported = connectedEnvironments.filter((candidate) => !supported.includes(candidate));
  const updateSettings = useUpdateScopedSettingsOn(supported);
  const [draft, setDraft] = useState<{ readonly owner: string; readonly login: string } | null>(
    null,
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  if (isProjectScope || connectedEnvironments.length === 0) return null;

  const setting = searchableSetting("github-account-rules");
  if (supported.length === 0) {
    return (
      <SettingsSection id={setting.id} title={setting.title}>
        <SettingsRow
          title="Update these machines"
          description={`GitHub account rules need a newer server on ${joinLabels(unsupported.map((candidate) => candidate.label))}.`}
        />
      </SettingsSection>
    );
  }

  // Only the machines that understand the rules take part in "mixed" and in
  // what the editor shows; an older server cannot have any rules yet.
  const ruleSets = new Set(
    supported.map((candidate) =>
      JSON.stringify(candidate.serverConfig?.settings.gitHubAccountRules ?? []),
    ),
  );
  const mixed = ruleSets.size > 1;
  const rules: ReadonlyArray<GitHubAccountRule> =
    supported[0]!.serverConfig?.settings.gitHubAccountRules ?? [];
  const accounts = accountOptions(discovery);
  const bulk = scope.kind === "all" && connectedEnvironments.length > 1;
  const excludedRow =
    unsupported.length === 0 ? null : (
      <SettingsRow
        title="Not applied on older servers"
        description={`${joinLabels(unsupported.map((candidate) => candidate.label))} run a server without account rules; update them to include them.`}
      />
    );
  const write = (next: ReadonlyArray<GitHubAccountRule>) =>
    updateSettings({ gitHubAccountRules: next });
  const setError = (key: string, message: string | null) =>
    setErrors((current) => {
      const rest = Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key));
      return message === null ? rest : { ...rest, [key]: message };
    });
  const commitOwner = (index: number, value: string) => {
    const message = validateOwnerPattern(value);
    setError(String(index), message);
    if (message !== null) return;
    const owner = value.trim();
    if (owner !== rules[index]?.owner) write(updateRule(rules, index, { owner }));
  };
  const commitDraftOwner = (value: string) => {
    if (draft === null) return;
    const message = validateOwnerPattern(value);
    setError("draft", message);
    if (message !== null) return;
    write(addRule(rules, { host: DEFAULT_HOST, owner: value.trim(), login: draft.login }));
    setDraft(null);
  };

  if (accounts.length < 2) {
    return (
      <SettingsSection id={setting.id} title={setting.title}>
        <SettingsRow
          title="One account per repository"
          description={`Sign in to a second GitHub account with \`gh auth login\` on ${environment?.label ?? "this machine"} to choose an account per repository owner.`}
        />
        {excludedRow}
      </SettingsSection>
    );
  }

  if (mixed) {
    return (
      <SettingsSection id={setting.id} title={setting.title}>
        <SettingsRow
          title="Rules differ between machines"
          description="Choose one machine in the breadcrumb to edit its rules, or pick a value here to apply it everywhere."
          control={
            <Button size="xs" variant="outline" onClick={() => write(rules)}>
              {`Use ${supported[0]!.label}'s rules everywhere`}
            </Button>
          }
        />
        {excludedRow}
      </SettingsSection>
    );
  }

  const firstLogin = accounts[0]!.login;
  const ruleRow = (
    key: string,
    owner: string,
    login: string,
    onOwnerBlur: (value: string) => void,
    onLogin: (login: string) => void,
    actions: React.ReactNode,
  ) => (
    <SettingsRow
      key={key}
      title={
        <span className="flex items-center gap-2">
          <Input
            size="sm"
            aria-label="Repository owner pattern"
            placeholder="owner or geico-*"
            defaultValue={owner}
            onBlur={(event) => onOwnerBlur((event.target as HTMLInputElement).value)}
          />
          <span className="text-xs text-muted-foreground">uses</span>
        </span>
      }
      description={errors[key] === undefined ? undefined : errors[key]}
      className={errors[key] === undefined ? undefined : "text-destructive"}
      control={
        <span className="flex items-center gap-1">
          <AccountSelect value={login} accounts={accounts} label="Account" onChange={onLogin} />
          {actions}
        </span>
      }
    />
  );

  return (
    <SettingsSection
      id={setting.id}
      title={setting.title}
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={draft !== null}
          onClick={() => setDraft({ owner: "", login: firstLogin })}
        >
          <PlusIcon className="size-3.5" />
          Add rule
        </Button>
      }
    >
      <SettingsRow
        title="Owner rules"
        description={
          bulk
            ? `The first rule whose owner pattern matches a repository picks its gh account; * matches anything, no match uses the active account. Rules cover every machine unless you pick one. Accounts from ${environment?.label ?? "the selected machine"}.`
            : "The first rule whose owner pattern matches a repository decides which gh account its commands use. * matches any characters. Repositories with no match use the active gh account."
        }
      />
      {rules.map((rule, index) =>
        ruleRow(
          `${index}:${rule.owner}:${rule.login}`,
          rule.owner,
          rule.login,
          (value) => commitOwner(index, value),
          (login) => write(updateRule(rules, index, { login })),
          <>
            <IconButton
              label={`Move rule ${index + 1} up`}
              disabled={index === 0}
              onClick={() => write(moveRule(rules, index, -1))}
            >
              <ArrowUpIcon className="size-3" />
            </IconButton>
            <IconButton
              label={`Move rule ${index + 1} down`}
              disabled={index === rules.length - 1}
              onClick={() => write(moveRule(rules, index, 1))}
            >
              <ArrowDownIcon className="size-3" />
            </IconButton>
            <IconButton
              label={`Remove rule ${index + 1}`}
              onClick={() => write(removeRule(rules, index))}
            >
              <XIcon className="size-3" />
            </IconButton>
          </>,
        ),
      )}
      {draft === null
        ? null
        : ruleRow(
            "draft",
            draft.owner,
            draft.login,
            commitDraftOwner,
            (login) => setDraft({ ...draft, login }),
            <IconButton label="Discard new rule" onClick={() => setDraft(null)}>
              <XIcon className="size-3" />
            </IconButton>,
          )}
      {excludedRow}
    </SettingsSection>
  );
}
