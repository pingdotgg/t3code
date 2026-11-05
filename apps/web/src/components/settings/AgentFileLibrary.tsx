import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentFileSyncBundle, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { CheckIcon, FileTextIcon, LayersIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { agentFileSync } from "../../state/agentFileSync";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AgentFileSharing } from "./AgentFileSharing";
import {
  type AgentFileLocation,
  type AgentFileShare,
  type AgentLibraryResource,
  locationLabel,
  resourceKey,
  resourceScopeLabel,
  resourceShares,
} from "./agentFileLibrary";

const linksAtom = environmentAtomList("agent-file-library:links", (environmentId) =>
  agentFileSync.links({ environmentId, input: {} }),
);

export function AgentFileLibrary({
  source,
  destinations,
  globalLocations,
  compatible,
  connected,
}: {
  source: AgentFileLocation;
  destinations: AgentFileLocation[];
  globalLocations: AgentFileLocation[];
  compatible: (target: AgentFileLocation) => boolean;
  connected: (target: AgentFileLocation) => boolean;
}) {
  const globalLocation = globalLocations.find(
    (location) => location.environmentId === source.environmentId,
  )!;
  const globalCatalog = useEnvironmentQuery(
    agentFileSync.list({ environmentId: source.environmentId, input: {} }),
  );
  const projectCatalog = useEnvironmentQuery(
    source.cwd
      ? agentFileSync.list({ environmentId: source.environmentId, input: { cwd: source.cwd } })
      : null,
  );
  const availableLocations = globalLocations.filter(
    (location) => compatible(location) && connected(location),
  );
  const ids = environmentIdsKey(availableLocations.map((location) => location.environmentId));
  const linkResults = useAtomValue(linksAtom(ids));
  const shares: AgentFileShare[] = availableLocations.flatMap((location, index) => {
    const result = linkResults[index];
    return (result ? (Option.getOrNull(AsyncResult.value(result)) ?? []) : []).map((link) => ({
      environmentId: location.environmentId,
      environmentLabel: locationLabel({ ...location, ...link.scope }),
      sourceLabel: locationLabel({
        id: link.sourceEnvironmentId,
        environmentId: link.sourceEnvironmentId,
        label:
          globalLocations.find((source) => source.environmentId === link.sourceEnvironmentId)
            ?.label ?? link.label,
        ...(link.selection.cwd ? { cwd: link.selection.cwd } : {}),
      }),
      link,
    }));
  });
  const sharingKnown =
    availableLocations.length === globalLocations.length &&
    linkResults.every((result) => result._tag === "Success");
  const refreshSharing = () => {
    for (const environmentId of ids.split("\n") as EnvironmentId[]) {
      if (environmentId) appAtomRegistry.refresh(agentFileSync.links({ environmentId, input: {} }));
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the subscription refresh timer while the library is mounted.
  useEffect(() => {
    const environmentIds = ids.split("\n") as EnvironmentId[];
    const timer = setInterval(() => {
      for (const environmentId of environmentIds) {
        if (environmentId)
          appAtomRegistry.refresh(agentFileSync.links({ environmentId, input: {} }));
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [ids]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const resources = [
    ...(source.cwd ? [{ location: source, catalog: projectCatalog }] : []),
    { location: globalLocation, catalog: globalCatalog },
  ].flatMap(({ location, catalog }) => {
    const entries: AgentLibraryResource[] = [
      ...(catalog.data?.skills ?? []).map((skill) => ({
        ...skill,
        kind: "skill" as const,
        location,
        sections: [],
      })),
      ...(catalog.data?.instructions ?? []).map((file) => ({
        ...file,
        kind: "instructions" as const,
        name: file.path.split("/").at(-1)!,
        location,
      })),
    ];
    if (catalog.isSuccess || catalog.error) {
      const known = new Set(entries.map((entry) => `${entry.kind}:${entry.path}`));
      for (const { environmentId, link } of shares) {
        const incoming =
          environmentId === location.environmentId && link.scope.cwd === location.cwd;
        const outgoing =
          link.sourceEnvironmentId === location.environmentId &&
          link.selection.cwd === location.cwd;
        if (!incoming && !outgoing) continue;
        for (const candidate of [
          ...link.selection.skills.map((path) => ({ kind: "skill" as const, path })),
          ...link.selection.instructions.map(({ path }) => ({
            kind: "instructions" as const,
            path,
          })),
        ]) {
          const key = `${candidate.kind}:${candidate.path}`;
          if (known.has(key)) continue;
          known.add(key);
          entries.push({
            ...candidate,
            name: candidate.path.split("/").at(-1)!,
            location,
            sections: [],
            unavailable: true,
          });
        }
      }
    }
    return entries;
  });
  const visible = resources.filter((resource) =>
    `${resource.name} ${resource.path} ${resourceScopeLabel(resource.location)}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const resource =
    visible.find((item) => resourceKey(item) === selected) ??
    visible.find((item) => item.kind === "skill") ??
    visible[0];
  const exported = useEnvironmentQuery(
    resource?.kind === "skill" && !resource.unavailable
      ? agentFileSync.export({
          environmentId: resource.location.environmentId,
          input: {
            ...(resource.location.cwd ? { cwd: resource.location.cwd } : {}),
            skills: [resource.path],
            instructions: [],
          },
        })
      : null,
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            aria-label="Find skills or instructions"
            placeholder="Find skills or instruction files…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh files"
          onClick={() => {
            globalCatalog.refresh();
            projectCatalog.refresh();
            exported.refresh();
            refreshSharing();
          }}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
      </div>
      {[
        { catalog: globalCatalog, scope: "global" },
        ...(source.cwd ? [{ catalog: projectCatalog, scope: "project" }] : []),
      ].map(({ catalog, scope }) => (
        <div key={scope} className="empty:hidden">
          {catalog.error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {catalog.error}
            </p>
          ) : null}
          {catalog.data?.warnings.map((warning) => (
            <p key={warning} className="text-xs text-muted-foreground">
              {warning}
            </p>
          ))}
          {catalog.isPending ? (
            <p className="text-sm text-muted-foreground">Reading {scope} files…</p>
          ) : null}
        </div>
      ))}
      {!sharingKnown ? (
        <p className="text-xs text-muted-foreground">
          Sharing status is unavailable for some environments. Connect them to see all destinations.
        </p>
      ) : null}
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1.8fr)]">
        <nav
          aria-label="Skills and instruction files"
          className="max-h-72 min-w-0 overflow-y-auto rounded-lg border lg:max-h-none"
        >
          {(["skill", "instructions"] as const).map((kind) => (
            <section key={kind} className="not-first:border-t">
              <h3 className="flex items-center gap-2 bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                {kind === "skill" ? (
                  <SparklesIcon className="size-3.5" />
                ) : (
                  <FileTextIcon className="size-3.5" />
                )}
                {kind === "skill" ? "Skills" : "Instruction files"}
                <span className="ms-auto tabular-nums">
                  {visible.filter((item) => item.kind === kind).length}
                </span>
              </h3>
              <div className="max-h-80 overflow-y-auto">
                {visible
                  .filter((item) => item.kind === kind)
                  .map((item) => {
                    const { incoming, outgoing } = resourceShares(item, shares);
                    return (
                      <button
                        key={resourceKey(item)}
                        type="button"
                        aria-current={
                          resource && resourceKey(resource) === resourceKey(item)
                            ? "true"
                            : undefined
                        }
                        onClick={() => setSelected(resourceKey(item))}
                        className={cn(
                          "flex w-full flex-col gap-1 border-t border-border/50 px-3 py-2.5 text-left text-sm hover:bg-accent/50",
                          resource &&
                            resourceKey(resource) === resourceKey(item) &&
                            "bg-accent text-accent-foreground",
                        )}
                      >
                        <span className="break-words font-medium">{item.name}</span>
                        <span className="break-all font-mono text-2xs text-muted-foreground">
                          {item.path}
                        </span>
                        <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          <span>{resourceScopeLabel(item.location)}</span>
                          {item.unavailable ? (
                            <span className="text-warning">Unavailable</span>
                          ) : null}
                          {incoming.length ? (
                            <span>
                              Inherited from{" "}
                              {incoming.map(({ sourceLabel }) => sourceLabel).join(", ")}
                            </span>
                          ) : null}
                          {outgoing.length ? <span>Shared with {outgoing.length}</span> : null}
                          {[...incoming, ...outgoing].some(({ link }) => link.paused) ? (
                            <span className="text-warning">Paused</span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                {!visible.some((item) => item.kind === kind) ? (
                  <p className="px-3 py-4 text-xs text-muted-foreground">
                    {filter
                      ? "No matching files."
                      : kind === "skill"
                        ? "No skills found."
                        : "No instruction files found."}
                  </p>
                ) : null}
              </div>
            </section>
          ))}
        </nav>
        {resource ? (
          <ResourceDetails
            key={resourceKey(resource)}
            resource={resource}
            exported={exported}
            shares={shares}
            sharingKnown={sharingKnown}
            refreshSharing={refreshSharing}
            destinations={(resource.location.cwd ? destinations : globalLocations).filter(
              (location) => location.id !== resource.location.id,
            )}
            compatible={compatible}
            connected={connected}
          />
        ) : (
          <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            {filter
              ? "Try a different search."
              : "Skills and instruction files will appear here when they exist on this environment."}
          </div>
        )}
      </div>
    </div>
  );
}

function ResourceDetails({
  resource,
  exported,
  shares,
  sharingKnown,
  refreshSharing,
  destinations,
  compatible,
  connected,
}: {
  resource: AgentLibraryResource;
  exported: EnvironmentQueryView<AgentFileSyncBundle>;
  shares: AgentFileShare[];
  sharingKnown: boolean;
  refreshSharing: () => void;
  destinations: AgentFileLocation[];
  compatible: (target: AgentFileLocation) => boolean;
  connected: (target: AgentFileLocation) => boolean;
}) {
  const { incoming, outgoing } = resourceShares(resource, shares);
  return (
    <section
      aria-label={`${resource.name} details`}
      className="min-w-0 overflow-hidden rounded-lg border"
    >
      <header className="flex flex-col gap-2 border-b p-4">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 break-words text-base font-medium">{resource.name}</h3>
          <ResourceOrigin resource={resource} incoming={incoming} />
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">
          {resource.location.cwd ? `${resource.location.cwd}/` : "~/"}
          {resource.path}
        </p>
        <p className="text-xs text-muted-foreground">
          {resourceScopeLabel(resource.location)} · {resource.location.label}
          {outgoing.length
            ? ` · Shared with ${outgoing.map((share) => share.environmentLabel).join(", ")}`
            : incoming.length
              ? resource.kind === "instructions"
                ? " · Includes inherited sections"
                : " · Inherited from another environment"
              : sharingKnown
                ? " · Not shared"
                : ""}
        </p>
      </header>
      <div className="p-4">
        <ResourceContents resource={resource} exported={exported} />
      </div>
      <div className="flex flex-col gap-3 border-t p-4">
        <h4 className="text-sm font-medium">Source & sharing</h4>
        {!incoming.length && !resource.unavailable ? (
          <p className="text-xs text-muted-foreground">
            {resource.location.cwd
              ? "Defined in this project."
              : "Defined globally on this environment. Global files can apply alongside project files. Your agent determines which files it loads."}
          </p>
        ) : null}
        {incoming.map((share) => (
          <ShareStatus
            key={share.link.id}
            share={share}
            direction="incoming"
            onChange={refreshSharing}
            resource={resource}
          />
        ))}
        {outgoing.map((share) => (
          <ShareStatus
            key={share.link.id}
            share={share}
            direction="outgoing"
            onChange={refreshSharing}
            resource={resource}
          />
        ))}
        {!resource.unavailable ? (
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Share {resource.kind === "skill" ? "this skill" : "sections of this file"}…
            </summary>
            <div className="mt-4">
              <AgentFileSharing
                resource={resource}
                destinations={destinations}
                compatible={compatible}
                connected={connected}
              />
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}

function ResourceOrigin({
  resource,
  incoming,
}: {
  resource: AgentLibraryResource;
  incoming: AgentFileShare[];
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-micro"
            aria-label="Show where this file comes from"
          />
        }
      >
        <LayersIcon className="size-3" />
      </PopoverTrigger>
      <PopoverPopup align="start" width="md" padding="compact">
        <h4 className="mb-2 text-xs font-medium text-muted-foreground">
          Where this file comes from
        </h4>
        <ol className="flex flex-col gap-1 text-sm">
          {incoming.map(({ link, sourceLabel }) => (
            <li key={link.id} className="rounded-md px-2 py-1">
              <span className="block font-medium">{sourceLabel}</span>
              <span className="block break-all text-xs text-muted-foreground">
                {link.selection.cwd ?? "Global"} · {resource.path}
              </span>
            </li>
          ))}
          <li className="flex items-start justify-between gap-2 rounded-md bg-foreground/[0.06] px-2 py-1">
            <span>
              <span className="block font-medium">
                {resourceScopeLabel(resource.location)} · {resource.location.label}
              </span>
              <span className="block text-xs text-muted-foreground">
                {incoming.length
                  ? "Receives shared content"
                  : resource.unavailable
                    ? "Unavailable local file"
                    : "Local file"}
              </span>
            </span>
            <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
          </li>
        </ol>
        {resource.location.cwd ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Global files are listed separately. Provider loading rules determine how global and
            project instructions combine.
          </p>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function ResourceContents({
  resource,
  exported,
}: {
  resource: AgentLibraryResource;
  exported: EnvironmentQueryView<AgentFileSyncBundle>;
}) {
  const files =
    exported.data?.find(
      (item): item is Extract<AgentFileSyncBundle[number], { kind: "skill" }> =>
        item.kind === "skill",
    )?.files ?? [];
  const [filePath, setFilePath] = useState("SKILL.md");
  const file = files.find((item) => item.path === filePath) ?? files[0];
  if (resource.unavailable)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        This shared file is unavailable in the current inventory. Check its path on the environment
        and refresh, or stop sharing below.
      </p>
    );

  let text = resource.contents ?? resource.sections.map((section) => section.contents).join("");
  let binary = false;
  if (resource.kind === "skill" && file) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0)),
      );
      binary = text.includes("\0");
    } catch {
      binary = true;
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">Contents</h4>
        {resource.kind === "instructions" && resource.contents === undefined ? (
          <p className="text-xs text-muted-foreground">
            Local sections only · update this environment to read the full file
          </p>
        ) : null}
      </div>
      {resource.kind === "skill" && files.length ? (
        <Select
          value={file?.path ?? null}
          onValueChange={(value) => {
            if (value) setFilePath(value);
          }}
          items={files.map((item) => ({ value: item.path, label: item.path }))}
        >
          <SelectTrigger aria-label="Skill file">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {files.map((item) => (
              <SelectItem key={item.path} value={item.path}>
                {item.path}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
      {exported.error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {exported.error}
        </p>
      ) : exported.isPending ? (
        <p className="text-sm text-muted-foreground">Reading skill…</p>
      ) : binary ? (
        <p className="text-sm text-muted-foreground">
          Binary file · included when this skill is shared.
        </p>
      ) : (
        <FileLines key={file?.path ?? resource.path} contents={text} />
      )}
    </div>
  );
}

function FileLines({ contents }: { contents: string }) {
  const [page, setPage] = useState(0);
  const lines = contents.split(/\r?\n/);
  const currentPage = Math.min(page, Math.floor((lines.length - 1) / 200));
  const start = currentPage * 200;
  return (
    <div className="min-w-0">
      <div
        className="max-h-96 overflow-auto rounded-md border bg-muted/20"
        tabIndex={0}
        aria-label="File contents with line numbers"
      >
        <pre className="min-w-full w-max py-2 text-xs leading-5">
          {lines.slice(start, start + 200).map((line, index) => (
            <div key={`line-${start + index + 1}`} className="flex">
              <span
                aria-hidden="true"
                className="sticky left-0 w-12 shrink-0 select-none border-r bg-background pe-3 text-right text-muted-foreground/60"
              >
                {start + index + 1}
              </span>
              <code className="px-3">{line || " "}</code>
            </div>
          ))}
        </pre>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {lines.length} lines
          {lines.length > 200
            ? ` · Showing ${start + 1}–${Math.min(start + 200, lines.length)}`
            : ""}
        </span>
        {lines.length > 200 ? (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous lines
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={start + 200 >= lines.length}
              onClick={() => setPage(currentPage + 1)}
            >
              Next lines
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ShareStatus({
  share,
  direction,
  onChange,
  resource,
}: {
  share: AgentFileShare;
  direction: "incoming" | "outgoing";
  onChange: () => void;
  resource: AgentLibraryResource;
}) {
  const { link } = share;
  const allowed = useAtomValue(agentFileSync.manage.permissionAtom(share.environmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sections =
    resource.kind === "instructions"
      ? (link.selection.instructions.find((file) => file.path === resource.path)?.sectionIds ?? [])
      : [];
  const count =
    link.selection.skills.length +
    link.selection.instructions.reduce((n, file) => n + file.sectionIds.length, 0);
  const manage = async (action: "pause" | "resume" | "remove") => {
    setBusy(true);
    setError(null);
    try {
      const result = await runAtomCommand(
        appAtomRegistry,
        agentFileSync.manage,
        {
          environmentId: share.environmentId,
          input: { id: link.id, action },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not update sharing.");
      }
      onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update sharing.");
    }
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          {direction === "incoming"
            ? `Inherited from ${share.sourceLabel}`
            : `Shared with ${share.environmentLabel}`}
        </p>
        <span className={cn("text-xs", link.paused ? "text-warning" : "text-muted-foreground")}>
          {link.paused ? "Paused" : "Automatic"}
        </span>
      </div>
      <p className="break-all text-xs text-muted-foreground">
        {direction === "incoming"
          ? (link.selection.cwd ?? "Global files")
          : (link.scope.cwd ?? "Global files")}{" "}
        · Updated {new Date(link.lastSyncedAt).toLocaleString()}
      </p>
      {sections.length ? (
        <p className="text-xs text-muted-foreground">
          Sections: {sections.map((id) => id.replace(/:\d+$/, "")).join(", ")}
        </p>
      ) : null}
      {link.error || error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error ?? link.error}
        </p>
      ) : null}
      {count > 1 ? (
        <p className="text-xs text-muted-foreground">
          These controls also affect the other items in this shared selection ({count} total).
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !allowed}
          onClick={() => void manage(link.paused ? "resume" : "pause")}
        >
          {link.paused ? "Resume" : "Pause"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !allowed}
          onClick={() => void manage("remove")}
        >
          Stop sharing
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Stopping sharing keeps the destination files.</p>
    </div>
  );
}
