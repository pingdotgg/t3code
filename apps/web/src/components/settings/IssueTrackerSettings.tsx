import { useAtomValue } from "@effect/atom-react";
import {
  boundIssueTrackerScopes,
  issueTrackerBindingFor,
  issueTrackerScopeOptions,
  issueTrackerSummary,
  hasIssueTrackerTeams,
} from "@t3tools/client-runtime/state/issue-trackers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { T, useGT, useMessages } from "gt-react";
import { ChevronDownIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { useState, type ElementType } from "react";
import type {
  EnvironmentId,
  IssueTrackerConnection,
  IssueTrackerConnectionList,
  ProjectId,
} from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { issueTrackerEnvironment } from "../../state/issueTrackers";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { LinearIcon } from "../Icons";
import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import { CheckboxMark } from "../ui/checkbox";
import { Button, InlineButton } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
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
  const trackers = query.data?.trackers ?? [];
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
            <Button size="xs" variant="outline" onClick={query.refresh}>
              <T>Retry</T>
            </Button>
          }
        />
      </SettingsSection>
    );
  }
  if (trackers.length === 0) return null;
  return (
    <SettingsSection id={searchableSetting("issue-trackers").id} title={title}>
      {trackers.map((tracker) => (
        <TrackerRow
          // Drafts belong to one environment; switching must not carry them over.
          key={`${tracker.tracker}-${environmentId}`}
          environmentId={environmentId}
          tracker={tracker}
          bindings={query.data?.bindings ?? {}}
          refreshing={query.isPending}
          refreshFailed={query.error !== null}
        />
      ))}
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
      input: { tracker: tracker.tracker, token },
    });
    setBusy(false);
    if (result._tag === "Success") return;
    const error = squashAtomCommandFailure(result);
    setFailure(error instanceof Error ? error.message : gt("The request failed."));
  };

  const inputId = `issue-tracker-${tracker.tracker}-${environmentId}`;
  const usable = tracker.connected && tracker.account !== null;
  const summary = issueTrackerSummary(tracker, bindings, messages);

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
                <T>Credential rejected</T>
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
          aria-label={gt("Toggle {tracker} details", { tracker: tracker.displayName })}
        >
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
          />
        </Button>
      </div>
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        {/* Kept mounted so a pick awaiting its refresh stays locked when the panel is reopened. */}
        <CollapsibleContent keepMounted>
          {/* Locked while saving, so an edit made mid-request is not overwritten by the saved value. */}
          <fieldset disabled={!canEdit || busy} className="contents">
            <div className="px-3 pb-4 pt-1 sm:px-4">
              <SettingsRow
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
                        aria-label={gt("Disconnect {tracker}", { tracker: tracker.displayName })}
                      >
                        <XIcon className="size-3.5" />
                      </Button>
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
    picks[projectId] ?? boundIssueTrackerScopes(tracker.tracker, bindings[projectId]);
  if (projects.length === 0 || !hasIssueTrackerTeams(tracker, bindings)) return null;

  const change = async (projectId: ProjectId, scopes: ReadonlyArray<string>) => {
    if (busy) return;
    const binding = issueTrackerBindingFor(tracker.tracker, bound(projectId), scopes);
    const before = picks[projectId];
    setSaving(true);
    setPicks((current) => ({
      ...current,
      [projectId]: boundIssueTrackerScopes(tracker.tracker, binding ?? undefined),
    }));
    const result = await bind({ environmentId, input: { projectId, binding } });
    if (result._tag !== "Success") setPicks((current) => ({ ...current, [projectId]: before }));
    setSaving(false);
  };

  return (
    <>
      <SettingsRow
        title={gt("Projects")}
        description={gt(
          "Pick one or more {tracker} {scope}s for each project. Their issues list beside the repository's own, and agents file new issues in the first one unless asked for another.",
          { tracker: tracker.displayName, scope: tracker.scopeNoun },
        )}
      />
      {projects.map((project) => {
        // A project bound to another tracker keeps that binding; this picker shows it unbound.
        const value = bound(project.id);
        const options = issueTrackerScopeOptions(tracker, value);
        return (
          <SettingsRow
            key={project.id}
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
                  className="w-full @min-[32rem]/settings-row:w-56"
                  size="sm"
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
