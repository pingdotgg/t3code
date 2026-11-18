import { useAtomValue } from "@effect/atom-react";
import { issueTrackerSummary } from "@t3tools/client-runtime/state/issue-trackers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState, type ElementType } from "react";
import type {
  EnvironmentId,
  IssueTrackerConnection,
  IssueTrackerConnectionList,
} from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { issueTrackerEnvironment } from "../../state/issueTrackers";
import { useAtomCommand } from "../../state/use-atom-command";
import { LinearIcon } from "../Icons";
import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";

type TrackerIcon = ElementType<{ className?: string }>;

/** Web art per tracker kind; the server supplies everything else about a tracker. */
const TRACKER_ICONS: Partial<Record<string, TrackerIcon>> = {
  linear: LinearIcon,
};

const UNBOUND = "";

type EnvironmentConnections = ReadonlyMap<EnvironmentId, IssueTrackerConnectionList>;

const connectionsAcrossEnvironmentsAtom = Atom.family((environmentIdsKey: string) => {
  const environmentIds = JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>;
  return Atom.make((get): EnvironmentConnections => {
    const connections = new Map<EnvironmentId, IssueTrackerConnectionList>();
    for (const environmentId of environmentIds) {
      const result = get(issueTrackerEnvironment.connections({ environmentId, input: {} }));
      const data = AsyncResult.getOrElse(result, () => null);
      if (data !== null) connections.set(environmentId, data);
    }
    return connections;
  }).pipe(Atom.withLabel(`web-settings-issue-tracker-connections:${environmentIdsKey}`));
});

/**
 * Standalone issue trackers for the environments in scope: connect each with a credential, and
 * bind projects to one of the tracker's scopes so their issues list beside the git host's. The
 * first environment supplies what is shown; every write reaches all of them. Generic over the
 * trackers the server reports; nothing here names Linear but its icon.
 */
export function IssueTrackerSettings({
  environmentIds,
}: {
  readonly environmentIds: readonly [EnvironmentId, ...EnvironmentId[]];
}) {
  const environmentId = environmentIds[0];
  const connections = useAtomValue(
    connectionsAcrossEnvironmentsAtom(JSON.stringify(environmentIds)),
  );
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
        <SettingsRow
          title="Could not load issue trackers"
          description={query.error}
          control={
            <Button size="xs" variant="outline" onClick={query.refresh}>
              Retry
            </Button>
          }
        />
      </SettingsSection>
    );
  }
  if (trackers.length === 0) return null;
  return (
    <SettingsSection id={searchableSetting("issue-trackers").id} title="Issue trackers">
      {trackers.map((tracker) => (
        <TrackerRow
          // Drafts belong to one environment; switching must not carry them over.
          key={`${tracker.tracker}-${environmentId}`}
          environmentIds={environmentIds}
          tracker={tracker}
          connections={connections}
        />
      ))}
    </SettingsSection>
  );
}

function TrackerRow({
  environmentIds,
  tracker,
  connections,
}: {
  readonly environmentIds: readonly [EnvironmentId, ...EnvironmentId[]];
  readonly tracker: IssueTrackerConnection;
  readonly connections: EnvironmentConnections;
}) {
  const environmentId = environmentIds[0];
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
    const results = await Promise.all(
      environmentIds.map((target) =>
        connect({ environmentId: target, input: { tracker: tracker.tracker, token } }),
      ),
    );
    setBusy(false);
    const failed = results.find((result) => result._tag !== "Success");
    if (failed === undefined) return;
    const error = squashAtomCommandFailure(failed);
    setFailure(error instanceof Error ? error.message : "The request failed.");
  };

  const inputId = `issue-tracker-${tracker.tracker}-${environmentId}`;
  const usable = tracker.connected && tracker.account !== null;
  const summary = issueTrackerSummary(
    tracker,
    Object.assign(
      {},
      ...[...connections.values()].map((list) => list.bindings),
    ) as IssueTrackerConnectionList["bindings"],
  );

  return (
    <div className="first:rounded-t-xl last:rounded-b-xl transition-colors hover:bg-muted/20">
      <div className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
              {Icon ? <Icon className="size-4.5 text-foreground/80" /> : null}
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
                  usable ? "bg-success" : "bg-muted-foreground/35",
                )}
              />
            </span>
            <span className="truncate text-sm font-medium text-foreground">
              {tracker.displayName}
            </span>
            {tracker.connected && tracker.account === null ? (
              <Badge variant="destructive" size="sm">
                Credential rejected
              </Badge>
            ) : null}
          </div>
          <p className="text-xs leading-normal text-muted-foreground/80">{summary}</p>
        </div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          onClick={() => setIsExpanded((open) => !open)}
          aria-expanded={isExpanded}
          aria-label={`Toggle ${tracker.displayName} details`}
        >
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
          />
        </Button>
      </div>
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CollapsibleContent>
          {/* Locked while saving, so an edit made mid-request is not overwritten by the saved value. */}
          <fieldset disabled={!canEdit || busy} className="contents">
            <div className="px-3 pb-4 pt-1 sm:px-4">
              <SettingsRow
                title={<label htmlFor={inputId}>{tracker.credential.label}</label>}
                description={
                  <>
                    Stored on the server.
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
                          Create one
                          <ExternalLinkIcon aria-hidden className="size-3" />
                        </InlineButton>
                      </>
                    ) : null}
                    {failure ? <span className="block text-destructive">{failure}</span> : null}
                  </>
                }
                control={
                  <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-56">
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
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost-destructive"
                        onClick={() => void submit(null)}
                        aria-label={`Disconnect ${tracker.displayName}`}
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                }
              />
              {usable ? (
                <ProjectBindings
                  environmentIds={environmentIds}
                  tracker={tracker}
                  connections={connections}
                />
              ) : null}
            </div>
          </fieldset>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * One picker per project in scope. Bindings are keyed by each machine's own project id, so a
 * project checked out on several environments is bound on each one where the tracker works.
 */
function ProjectBindings({
  environmentIds,
  tracker,
  connections,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly tracker: IssueTrackerConnection;
  readonly connections: EnvironmentConnections;
}) {
  const { groups } = useSettingsScope();
  const usableOn = (environmentId: EnvironmentId) => {
    const connection = connections
      .get(environmentId)
      ?.trackers.find((candidate) => candidate.tracker === tracker.tracker);
    return connection?.connected && connection.account !== null ? connection : null;
  };
  const projects = groups.flatMap((group) => {
    const members = group.memberProjects.filter(
      (member) =>
        environmentIds.includes(member.environmentId) && usableOn(member.environmentId) !== null,
    );
    return members.length === 0
      ? []
      : [{ key: group.projectKey, title: group.displayName, members }];
  });
  const bind = useAtomCommand(issueTrackerEnvironment.bindProject, {
    label: `bind project to ${tracker.displayName}`,
  });
  const [pending, setPending] = useState<string | null>(null);
  if (projects.length === 0 || tracker.scopes.length === 0) return null;

  const boundScope = (member: (typeof projects)[number]["members"][number]) => {
    const binding = connections.get(member.environmentId)?.bindings[member.id];
    return binding?.tracker === tracker.tracker ? binding.scope : UNBOUND;
  };

  const change = async (project: (typeof projects)[number], scope: string) => {
    setPending(project.key);
    await Promise.all(
      project.members
        .filter((member) =>
          // Clearing leaves a copy bound to another tracker alone.
          scope === UNBOUND
            ? boundScope(member) !== UNBOUND
            : usableOn(member.environmentId)?.scopes.some((candidate) => candidate.key === scope),
        )
        .map((member) =>
          bind({
            environmentId: member.environmentId,
            input: {
              projectId: member.id,
              binding: scope === UNBOUND ? null : { tracker: tracker.tracker, scope },
            },
          }),
        ),
    );
    setPending(null);
  };

  return (
    <>
      <SettingsRow
        title="Projects"
        description={`Pick the ${tracker.displayName} ${tracker.scopeNoun} whose issues each project lists beside its repository's own.`}
      />
      {projects.map((project) => {
        // Another tracker's binding, or copies that disagree (a partly failed save), read as
        // unbound, so picking the scope again completes the binding everywhere.
        const scopes = project.members.map(boundScope);
        const value = scopes.every((scope) => scope === scopes[0]) ? scopes[0]! : UNBOUND;
        return (
          <SettingsRow
            key={project.key}
            title={project.title}
            control={
              <Select
                value={value}
                disabled={pending === project.key}
                onValueChange={(next) => {
                  if (next !== null) void change(project, next);
                }}
              >
                <SelectTrigger
                  aria-label={`${tracker.displayName} ${tracker.scopeNoun} for ${project.title}`}
                  className="w-full @min-[32rem]/settings-row:w-56"
                  size="sm"
                >
                  <SelectValue>
                    {value === UNBOUND
                      ? "Not bound"
                      : (tracker.scopes.find((scope) => scope.key === value)?.name ?? value)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={UNBOUND}>Not bound</SelectItem>
                  {tracker.scopes.map((scope) => (
                    <SelectItem key={scope.key} value={scope.key}>
                      {scope.name} ({scope.key})
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
