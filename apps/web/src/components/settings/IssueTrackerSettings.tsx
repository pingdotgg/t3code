import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ExternalLinkIcon } from "lucide-react";
import { useState, type ChangeEvent, type ElementType } from "react";
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
          // Drafts belong to one environment; switching must not carry them over.
          key={`${tracker.tracker}-${environmentId}`}
          environmentId={environmentId}
          tracker={tracker}
          bindings={query.data?.bindings ?? {}}
        />
      ))}
    </SettingsSection>
  );
}

function TrackerRow({
  environmentId,
  tracker,
  bindings,
}: {
  readonly environmentId: EnvironmentId;
  readonly tracker: IssueTrackerConnection;
  readonly bindings: IssueTrackerConnectionList["bindings"];
}) {
  const Icon = TRACKER_ICONS[tracker.tracker];
  const canEdit = useAtomValue(issueTrackerEnvironment.connect.permissionAtom(environmentId));
  const connect = useAtomCommand(issueTrackerEnvironment.connect, {
    label: `connect ${tracker.displayName}`,
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const fields = tracker.credential.fields;
  const packed = packCredential(fields, draft);
  const inputId = `issue-tracker-${tracker.tracker}-${environmentId}`;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (token: string | null) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await connect({
        environmentId,
        input: { tracker: tracker.tracker, token },
      });
      if (result._tag === "Success") {
        setDraft({});
        return;
      }
      setFailure(connectFailureMessage(squashAtomCommandFailure(result)));
    } finally {
      setBusy(false);
    }
  };

  const status = !tracker.connected ? (
    <Badge variant="outline">Not connected</Badge>
  ) : tracker.account === null ? (
    <Badge variant="destructive">Not verified</Badge>
  ) : (
    <Badge variant="secondary">Connected as {tracker.account}</Badge>
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
          {tracker.connected ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canEdit || busy}
              onClick={() => void submit(null)}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
        {tracker.detail ? <p className="text-xs text-destructive">{tracker.detail}</p> : null}
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (packed !== null) void submit(packed);
          }}
        >
          {/* Locked while saving: a successful save clears the draft, which would drop mid-request edits. */}
          <fieldset disabled={!canEdit || busy} className="contents">
            <div className="grid gap-1.5">
              <Label htmlFor={fields === undefined ? inputId : undefined}>
                {tracker.credential.label}
                {tracker.credential.helpUrl ? (
                  <>
                    {" · "}
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
              </Label>
              {fields?.map((field) => {
                const id = `${inputId}-${field.key}`;
                const props = {
                  id,
                  size: "sm" as const,
                  required: true,
                  value: draft[field.key] ?? "",
                  onChange: (event: ChangeEvent<HTMLInputElement>) =>
                    setDraft((current) => ({ ...current, [field.key]: event.target.value })),
                };
                return (
                  <div key={field.key} className="grid gap-1">
                    <Label htmlFor={id}>{field.label}</Label>
                    {field.secret ? (
                      <SecretInput {...props} configured={tracker.connected} />
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
                    configured={tracker.connected}
                    value={draft[""] ?? ""}
                    onChange={(event) => setDraft({ "": event.target.value })}
                  />
                ) : null}
                <Button type="submit" size="sm" disabled={packed === null}>
                  {tracker.connected ? "Replace" : "Connect"}
                </Button>
              </div>
            </div>
          </fieldset>
          {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
        </form>
        {tracker.connected && tracker.account !== null ? (
          <ProjectBindings
            environmentId={environmentId}
            tracker={tracker}
            bindings={bindings}
            disabled={!canEdit}
          />
        ) : null}
      </div>
    </div>
  );
}

/** One picker per project of this environment: which of the tracker's scopes it reads, if any. */
function ProjectBindings({
  environmentId,
  tracker,
  bindings,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly tracker: IssueTrackerConnection;
  readonly bindings: IssueTrackerConnectionList["bindings"];
  readonly disabled: boolean;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const bind = useAtomCommand(issueTrackerEnvironment.bindProject, {
    label: `bind project to ${tracker.displayName}`,
  });
  const [pending, setPending] = useState<ProjectId | null>(null);
  if (projects.length === 0 || (tracker.scopes.length === 0 && !tracker.scopesTruncated)) {
    return null;
  }

  const change = async (projectId: ProjectId, scope: string) => {
    setPending(projectId);
    try {
      await bind({
        environmentId,
        input: {
          projectId,
          binding: scope === UNBOUND ? null : { tracker: tracker.tracker, scope },
        },
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">
        Pick the {tracker.displayName} {tracker.scopeNoun} whose issues each project lists beside
        its repository's own.
        {tracker.scopesTruncated
          ? ` Only the first ${tracker.scopes.length} are listed; enter a ${tracker.scopeNoun} key to bind another.`
          : null}
      </p>
      <ul className="grid gap-1.5">
        {projects.map((project) => {
          const bound = bindings[project.id];
          // A project bound to another tracker keeps that binding; this picker shows it unbound.
          const value = bound?.tracker === tracker.tracker ? bound.scope : UNBOUND;
          return (
            <li key={project.id} className="flex flex-wrap items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm">{project.title}</span>
              <Select
                value={value}
                disabled={disabled || pending === project.id}
                onValueChange={(next) => {
                  if (next !== null) void change(project.id, next);
                }}
              >
                <SelectTrigger
                  aria-label={`${tracker.displayName} ${tracker.scopeNoun} for ${project.title}`}
                  className="w-48"
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
              {tracker.scopesTruncated ? (
                <ScopeKeyForm
                  environmentId={environmentId}
                  tracker={tracker}
                  projectId={project.id}
                  projectTitle={project.title}
                  disabled={disabled || pending === project.id}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ScopeKeyForm({
  environmentId,
  tracker,
  projectId,
  projectTitle,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly tracker: IssueTrackerConnection;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly disabled: boolean;
}) {
  const bind = useAtomCommand(issueTrackerEnvironment.bindProject, {
    label: `bind project to ${tracker.displayName}`,
    reportFailure: false,
  });
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (scope: string) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await bind({
        environmentId,
        input: { projectId, binding: { tracker: tracker.tracker, scope } },
      });
      if (result._tag === "Success") {
        setKey("");
        return;
      }
      setFailure(connectionFailureDetail(squashAtomCommandFailure(result)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid basis-full gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (key.trim()) void submit(key.trim());
      }}
    >
      <fieldset disabled={disabled || busy} className="flex justify-end gap-2">
        <Input
          aria-label={`${tracker.displayName} ${tracker.scopeNoun} key for ${projectTitle}`}
          className="w-48"
          size="sm"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder={`${tracker.scopeNoun} key`}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={!key.trim()}>
          Bind
        </Button>
      </fieldset>
      {failure ? <p className="text-right text-xs text-destructive">{failure}</p> : null}
    </form>
  );
}
