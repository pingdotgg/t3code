import { useAtomValue } from "@effect/atom-react";
import {
  boundIssueTrackerScopes,
  hasIssueTrackerTeams,
  issueTrackerBindInput,
  issueTrackerBindingFor,
  issueTrackerBindings,
  issueTrackerScopeOptions,
  issueTrackerSummary,
} from "@t3tools/client-runtime/state/issue-trackers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { T, useGT, useMessages } from "gt-react";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  PlusIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useState, type ElementType } from "react";
import type {
  EnvironmentId,
  IssueTrackerConnection,
  IssueTrackerConnectionList,
  IssueTrackerKind,
  ProjectId,
} from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { issueTrackerEnvironment } from "../../state/issueTrackers";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { LinearIcon } from "../Icons";
import { cn } from "~/lib/utils";

import { CheckboxMark } from "../ui/checkbox";
import { Button, InlineButton } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

type TrackerIcon = ElementType<{ className?: string }>;

/** Web art per tracker kind; the server supplies everything else about a tracker. */
const TRACKER_ICONS: Partial<Record<string, TrackerIcon>> = {
  linear: LinearIcon,
};

/**
 * Standalone issue trackers for one environment: connect each with a credential, and bind the
 * environment's projects to the tracker's scopes so their issues list beside the git
 * host's. Generic over the trackers the server reports; nothing here names Linear but its icon.
 */
export function IssueTrackerSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const title = gt("Issue trackers");
  const query = useEnvironmentQuery(
    issueTrackerEnvironment.connections({ environmentId, input: {} }),
  );
  const canEdit = useAtomValue(issueTrackerEnvironment.connect.permissionAtom(environmentId));
  const canAddAccounts =
    useServerConfigs().get(environmentId)?.environment.capabilities.issueTrackerAccounts === true;
  const [addingTracker, setAddingTracker] = useState<IssueTrackerKind | null>(null);
  const trackers = query.data?.trackers ?? [];
  const accounts = query.data?.accounts ?? [];
  if (query.data === null && query.isPending) {
    return (
      <SettingsSection id={searchableSetting("issue-trackers").id} title={title}>
        <div className="grid gap-3 px-4 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-full" />
        </div>
      </SettingsSection>
    );
  }
  if (query.data === null && query.error !== null) {
    return (
      <SettingsSection id={searchableSetting("issue-trackers").id} title={title}>
        <SettingsRow
          title={gt("Could not load issue trackers")}
          description={query.error}
          control={
            <Button size="xs" variant="secondary" onClick={query.refresh}>
              <T>Retry</T>
            </Button>
          }
        />
      </SettingsSection>
    );
  }
  if (trackers.length === 0) return null;

  const addableTrackers = canAddAccounts
    ? trackers.filter(
        (tracker) =>
          tracker.connected || accounts.some((account) => account.tracker === tracker.tracker),
      )
    : [];
  const targetAddTracker =
    addingTracker === null
      ? null
      : (addableTrackers.find((tracker) => tracker.tracker === addingTracker) ?? null);
  const addAccountAction =
    addableTrackers.length === 0 ? null : addableTrackers.length === 1 ? (
      <Button
        type="button"
        size="xs"
        variant="secondary"
        disabled={!canEdit || targetAddTracker !== null}
        onClick={() => setAddingTracker(addableTrackers[0]!.tracker)}
      >
        <PlusIcon />
        <T>Add account</T>
      </Button>
    ) : (
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={!canEdit || targetAddTracker !== null}
            />
          }
        >
          <PlusIcon />
          <T>Add account</T>
        </MenuTrigger>
        <MenuPopup align="end">
          {addableTrackers.map((tracker) => {
            const Icon = TRACKER_ICONS[tracker.tracker];
            return (
              <MenuItem key={tracker.tracker} onClick={() => setAddingTracker(tracker.tracker)}>
                {Icon ? <Icon className="size-4 shrink-0" /> : null}
                <span>{tracker.displayName}</span>
              </MenuItem>
            );
          })}
        </MenuPopup>
      </Menu>
    );

  return (
    <SettingsSection
      id={searchableSetting("issue-trackers").id}
      title={title}
      headerAction={addAccountAction}
    >
      {trackers.flatMap((tracker) => {
        const added = accounts.filter((account) => account.tracker === tracker.tracker);
        return [tracker, ...added].map((account) => (
          <TrackerRow
            // Drafts belong to one environment; switching must not carry them over.
            key={`${tracker.tracker}-${account.accountId ?? ""}-${environmentId}`}
            environmentId={environmentId}
            tracker={account}
            bindings={issueTrackerBindings(query.data)}
            refreshing={query.isPending}
            refreshFailed={query.error !== null}
          />
        ));
      })}
      {targetAddTracker ? (
        <AddAccountRow
          key={`add-${targetAddTracker.tracker}-${environmentId}`}
          environmentId={environmentId}
          tracker={targetAddTracker}
          onClose={() => setAddingTracker(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

function TrackerRow({
  environmentId,
  tracker,
  bindings,
  refreshing,
  refreshFailed,
}: {
  readonly environmentId: EnvironmentId;
  readonly tracker: IssueTrackerConnection;
  readonly bindings: IssueTrackerConnectionList["bindings"];
  readonly refreshing: boolean;
  readonly refreshFailed: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const Icon = TRACKER_ICONS[tracker.tracker];
  const canEdit = useAtomValue(issueTrackerEnvironment.connect.permissionAtom(environmentId));
  const connect = useAtomCommand(issueTrackerEnvironment.connect, {
    label: `connect ${tracker.displayName}`,
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const submit = async (token: string | null) => {
    setBusy(true);
    setFailure(null);
    const result = await connect({
      environmentId,
      input: { tracker: tracker.tracker, accountId: tracker.accountId, token },
    });
    setBusy(false);
    if (result._tag === "Success") return true;
    const error = squashAtomCommandFailure(result);
    setFailure(error instanceof Error ? error.message : gt("The request failed."));
    return false;
  };

  const inputId = `issue-tracker-${tracker.tracker}-${tracker.accountId ?? ""}-${environmentId}`;
  const usable = tracker.connected && tracker.account !== null;
  const rejected = tracker.connected && tracker.account === null;
  const summary = issueTrackerSummary(tracker, bindings, messages);

  return (
    <div>
      <SettingsRow
        leading={Icon ? <Icon /> : null}
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate">{tracker.displayName}</span>
            {tracker.workspace ? (
              <span className="truncate text-meta text-muted-foreground">{tracker.workspace}</span>
            ) : null}
            {rejected ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      role="alert"
                      tabIndex={0}
                      aria-label={gt("Credential rejected")}
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded-badge text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  }
                >
                  <TriangleAlertIcon aria-hidden className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {tracker.detail ?? gt("Credential rejected")}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </span>
        }
        description={summary}
        trailing={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            onClick={() => setIsExpanded((open) => !open)}
            aria-expanded={isExpanded}
            aria-label={gt("Toggle {tracker} details", { tracker: tracker.displayName })}
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
            />
          </Button>
        }
      />
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        {/* Kept mounted so a pick awaiting its refresh stays locked when the panel is reopened. */}
        <CollapsibleContent keepMounted>
          {/* Locked while saving, so an edit made mid-request is not overwritten by the saved value. */}
          <fieldset disabled={!canEdit || busy} className="contents">
            <div className="mb-3 ms-4 me-3 border-s border-divider ps-3 sm:me-4 sm:ps-4 *:not-first:border-t *:not-first:border-divider">
              <SettingsRow
                className="rounded-none px-0 py-2.5 sm:px-0"
                title={<label htmlFor={inputId}>{tracker.credential.label}</label>}
                description={
                  <>
                    <T>Stored on the server.</T>
                    {tracker.credential.helpUrl ? (
                      <>
                        {" "}
                        <InlineButton
                          render={
                            <a
                              href={tracker.credential.helpUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                            />
                          }
                        >
                          <T>Create one</T>
                          <ExternalLinkIcon aria-hidden className="size-3" />
                        </InlineButton>
                      </>
                    ) : null}
                    {failure ? <span className="block text-destructive">{failure}</span> : null}
                  </>
                }
                control={
                  <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-64">
                    <SecretInput
                      id={inputId}
                      size="sm"
                      className="min-w-0 flex-1"
                      configured={tracker.connected}
                      value=""
                      onCommit={(next) => {
                        if (next.trim()) void submit(next.trim());
                      }}
                    />
                    {tracker.connected ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost-destructive"
                              onClick={() => void submit(null)}
                              aria-label={gt("Disconnect {tracker}", {
                                tracker: tracker.displayName,
                              })}
                            >
                              <XIcon className="size-3.5" />
                            </Button>
                          }
                        />
                        <TooltipPopup side="top">
                          {gt("Disconnect {tracker}", { tracker: tracker.displayName })}
                        </TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </div>
                }
              />
              {usable ? (
                <ProjectBindings
                  environmentId={environmentId}
                  tracker={tracker}
                  bindings={bindings}
                  refreshing={refreshing}
                  refreshFailed={refreshFailed}
                />
              ) : null}
            </div>
          </fieldset>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/** One picker per project of this environment: which of the tracker's scopes it reads, if any. */
function ProjectBindings({
  environmentId,
  tracker,
  bindings,
  refreshing,
  refreshFailed,
}: {
  readonly environmentId: EnvironmentId;
  readonly tracker: IssueTrackerConnection;
  readonly bindings: IssueTrackerConnectionList["bindings"];
  readonly refreshing: boolean;
  readonly refreshFailed: boolean;
}) {
  const gt = useGT();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const bind = useAtomCommand(issueTrackerEnvironment.bindProject, {
    label: `bind project to ${tracker.displayName}`,
  });
  const [picks, setPicks] = useState<Partial<Record<ProjectId, ReadonlyArray<string>>>>({});
  const [saving, setSaving] = useState(false);
  const held = Object.values(picks).some((scopes) => scopes !== undefined);
  if (held && !saving && !refreshing && !refreshFailed) setPicks({});
  const busy = saving || (held && refreshing);
  const bound = (projectId: ProjectId) =>
    picks[projectId] ?? boundIssueTrackerScopes(tracker, bindings[projectId]);
  if (projects.length === 0 || !hasIssueTrackerTeams(tracker, bindings)) return null;

  const change = async (projectId: ProjectId, scopes: ReadonlyArray<string>) => {
    if (busy) return;
    const binding = issueTrackerBindingFor(tracker, bound(projectId), scopes);
    const before = picks[projectId];
    setSaving(true);
    setPicks((current) => ({
      ...current,
      [projectId]: boundIssueTrackerScopes(tracker, binding ?? undefined),
    }));
    const result = await bind({
      environmentId,
      input: issueTrackerBindInput(projectId, tracker, binding),
    });
    if (result._tag !== "Success") setPicks((current) => ({ ...current, [projectId]: before }));
    setSaving(false);
  };

  return (
    <>
      <p className="py-2.5 text-pretty text-meta text-muted-foreground">
        {gt(
          "Pick one or more {tracker} {scope}s for each project. Their issues list beside the repository's own, and agents file new issues in the first one unless asked for another.",
          { tracker: tracker.displayName, scope: tracker.scopeNoun },
        )}
      </p>
      {projects.map((project) => {
        // A project bound to another tracker or account keeps that binding; this picker shows it unbound.
        const value = bound(project.id);
        const options = issueTrackerScopeOptions(tracker, value);
        return (
          <SettingsRow
            key={project.id}
            className="rounded-none px-0 py-2.5 sm:px-0"
            title={project.title}
            control={
              <Select
                multiple
                value={[...value]}
                disabled={busy}
                onValueChange={(next) => void change(project.id, next)}
              >
                <SelectTrigger
                  aria-label={gt("{tracker} {scope} for {project}", {
                    tracker: tracker.displayName,
                    scope: tracker.scopeNoun,
                    project: project.title,
                  })}
                  className="w-full @min-[32rem]/settings-row:w-64"
                  size="sm"
                  variant="well"
                >
                  <SelectValue>
                    {value.length === 0
                      ? gt("Not bound")
                      : value
                          .map(
                            (key) => tracker.scopes.find((scope) => scope.key === key)?.name ?? key,
                          )
                          .join(", ")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {options.map((scope) => (
                    <SelectItem
                      key={scope.key}
                      value={scope.key}
                      disabled={!scope.addable}
                      // The checkbox marks each pick; Base UI's shading of selected rows reads as a cursor.
                      data-selected={undefined}
                    >
                      <span className="flex items-center gap-2">
                        <CheckboxMark checked={value.includes(scope.key)} />
                        {scope.name} ({scope.key})
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        );
      })}
    </>
  );
}

/** A credential for another account of the tracker, added from the section header. */
function AddAccountRow({
  environmentId,
  tracker,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly tracker: IssueTrackerConnection;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const Icon = TRACKER_ICONS[tracker.tracker];
  const canEdit = useAtomValue(issueTrackerEnvironment.connect.permissionAtom(environmentId));
  const connect = useAtomCommand(issueTrackerEnvironment.connect, {
    label: `connect ${tracker.displayName}`,
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inputId = `issue-tracker-${tracker.tracker}-add-account-${environmentId}`;

  const submit = async (token: string) => {
    setBusy(true);
    setFailure(null);
    const result = await connect({
      environmentId,
      input: { tracker: tracker.tracker, token, addAccount: true },
    });
    setBusy(false);
    if (result._tag === "Success") {
      onClose();
      return;
    }
    const error = squashAtomCommandFailure(result);
    setFailure(error instanceof Error ? error.message : gt("The request failed."));
  };

  return (
    <fieldset disabled={!canEdit || busy} className="contents">
      <SettingsRow
        leading={Icon ? <Icon /> : null}
        title={<label htmlFor={inputId}>{tracker.credential.label}</label>}
        description={
          <>
            {gt("For the new {tracker} account.", { tracker: tracker.displayName })}
            {tracker.credential.helpUrl ? (
              <>
                {" "}
                <InlineButton
                  render={
                    <a
                      href={tracker.credential.helpUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    />
                  }
                >
                  <T>Create one</T>
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </InlineButton>
              </>
            ) : null}
            {failure ? <span className="block text-destructive">{failure}</span> : null}
          </>
        }
        control={
          <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-64">
            <SecretInput
              id={inputId}
              size="sm"
              className="min-w-0 flex-1"
              value=""
              onCommit={(next) => {
                if (next.trim()) void submit(next.trim());
              }}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    onClick={onClose}
                    aria-label={gt("Cancel")}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup side="top">
                <T>Cancel</T>
              </TooltipPopup>
            </Tooltip>
          </div>
        }
      />
    </fieldset>
  );
}
