import type {
  AgentSkillDetail,
  AgentSkillSummary,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import {
  BookOpenTextIcon,
  ArrowLeftIcon,
  RefreshCwIcon,
  SearchIcon,
  CloudIcon,
  MonitorIcon,
  FolderIcon,
  GlobeIcon,
} from "lucide-react";
import { connectionStatusText, type PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { type ReactNode, useDeferredValue, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  fetchEnvironmentSkill,
  fetchEnvironmentSkills,
} from "@t3tools/client-runtime/state/skills";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useActiveEnvironmentId, useProjects } from "../../state/entities";
import { usePreparedConnection } from "../../state/session";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import {
  filterSkillCatalog,
  skillInvocationLabel,
  type SkillCatalogFilters,
} from "@t3tools/client-runtime/providerSkills";

type SkillProject = { readonly title: string; readonly workspaceRoot: string };

const EMPTY_SKILLS: ReadonlyArray<AgentSkillSummary> = [];

const skillKey = (skill: AgentSkillSummary): string => skill.id;

const SKILL_MARKDOWN_COMPONENTS = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  img: ({ alt }) => (
    <span className="text-muted-foreground">{alt ? `[Image: ${alt}]` : "[Image]"}</span>
  ),
} satisfies Components;

function ScopeBadge({
  scope,
  project,
}: {
  scope: string | undefined;
  project?: SkillProject | undefined;
}) {
  return (
    <Badge
      size="sm"
      variant="secondary"
      title={scope === "project" ? project?.workspaceRoot : undefined}
    >
      {scope === "project" && project
        ? `Project · ${project.title}`
        : (scope ?? "Unspecified scope")}
    </Badge>
  );
}

function SkillsLoading() {
  return <Skeleton className="m-4 h-16" aria-label="Loading skills" />;
}

function SkillListItem({
  skill,
  selected,
  onSelect,
}: {
  skill: AgentSkillSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const first = skill.installations[0];
  if (!first) return null;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "w-full rounded-md px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-foreground/4 hover:text-foreground",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-foreground">
          {first.displayName ?? first.name}
        </span>
        <ScopeBadge scope={first.scope} />
      </span>
      <span className="mt-1 block truncate text-xs">
        {skill.installations
          .map(
            (entry) =>
              `${entry.providerName} (${entry.instanceId}) · ${entry.enabled ? "Enabled" : "Disabled"}`,
          )
          .join(", ")}
      </span>
      <span className="mt-1 block truncate text-xs text-muted-foreground">
        {skill.resolvedPath ?? first.path}
      </span>
      {first.description ? (
        <span className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {first.description}
        </span>
      ) : null}
    </button>
  );
}

function SkillDetailView({
  detail,
  project,
}: {
  detail: AgentSkillDetail;
  project: SkillProject | undefined;
}) {
  const first = detail.installations[0];
  if (!first) return null;
  return (
    <article className="min-w-0">
      <WorkspacePageContainer className="min-w-0">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 break-words text-lg font-semibold">
              {first.displayName ?? first.name}
            </h2>
            <ScopeBadge scope={first.scope} project={project} />
          </div>
          {first.description ? (
            <p className="text-sm leading-6 text-muted-foreground">{first.description}</p>
          ) : null}
        </header>

        <section className="space-y-3 text-xs" aria-label="Provider installations">
          <p className="text-muted-foreground">
            Invocation describes the provider policy. Disabled skills cannot run until enabled;
            disabled provider instances cannot run skills.
          </p>
          {detail.installations.map((entry) => (
            <div
              key={JSON.stringify([entry.instanceId, entry.path, entry.name])}
              className="space-y-2 rounded-md border border-border p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {entry.providerName} ({entry.instanceId})
                </span>
                <Badge variant="outline">{entry.provider}</Badge>
                <Badge variant="secondary">{entry.enabled ? "Enabled" : "Disabled"}</Badge>
                {!entry.providerEnabled ? <Badge variant="outline">Provider disabled</Badge> : null}
                <Badge variant="outline">{skillInvocationLabel(entry)}</Badge>
                <ScopeBadge scope={entry.scope} project={project} />
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
                <dt>Skill name</dt>
                <dd className="break-words">
                  {entry.name}
                  {entry.displayName ? ` · ${entry.displayName}` : ""}
                </dd>
                {entry.description ? (
                  <>
                    <dt>Description</dt>
                    <dd>{entry.description}</dd>
                  </>
                ) : null}
                <dt>Installation path</dt>
                <dd className="break-all font-mono">{entry.path}</dd>
                <dt>Resolved destination</dt>
                <dd className="break-all font-mono">
                  {detail.resolvedPath ?? "Unavailable — refresh after restoring the file"}
                </dd>
              </dl>
            </div>
          ))}
        </section>

        <div className="border-t border-border pt-5">
          {detail.content ? (
            <div className="chat-markdown min-w-0 break-words text-sm leading-relaxed text-foreground/80">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={SKILL_MARKDOWN_COMPONENTS}
              >
                {detail.content}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">This skill has no instructions.</p>
          )}
        </div>
      </WorkspacePageContainer>
    </article>
  );
}

export function SkillsPage() {
  const { environments: allEnvironments } = useEnvironments();
  const environments = allEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.skills === true,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useActiveEnvironmentId();
  const projects = useProjects();
  const [selection, setSelection] = useState<{
    environmentId: EnvironmentId | null;
    projectId: ProjectId | null;
  }>({
    environmentId: null,
    projectId: null,
  });
  const environment =
    environments.find(
      (item) =>
        item.environmentId ===
        (selection.environmentId ?? activeEnvironmentId ?? primaryEnvironmentId),
    ) ??
    environments.find((item) => item.environmentId === primaryEnvironmentId) ??
    environments[0];
  const environmentId = environment?.environmentId ?? null;
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const project =
    selection.environmentId === environmentId
      ? environmentProjects.find((item) => item.id === selection.projectId)
      : undefined;
  const projectId = project?.id ?? null;
  const prepared = usePreparedConnection(environmentId);
  const connection =
    environment?.connection.phase === "connected" ? Option.getOrNull(prepared) : null;
  const EnvironmentIcon =
    environment?.entry.target._tag === "PrimaryConnectionTarget" ? MonitorIcon : CloudIcon;
  const selectors = (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1 border-t border-border px-3 py-2 sm:px-5"
      role="group"
      aria-label="Skill location"
    >
      <Select
        modal={false}
        value={environmentId}
        items={environments.map((item) => ({ value: item.environmentId, label: item.label }))}
        onValueChange={(value) => {
          const next = environments.find((item) => item.environmentId === value);
          if (next) setSelection({ environmentId: next.environmentId, projectId: null });
        }}
      >
        <SelectTrigger
          variant="ghost"
          size="xs"
          aria-label="Environment"
          className="min-w-0 max-w-full font-medium sm:max-w-64"
        >
          <EnvironmentIcon className="size-3 shrink-0" />
          <SelectValue className="truncate">{environment?.label ?? "No environments"}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {environments.map((item) => {
            const Icon =
              item.entry.target._tag === "PrimaryConnectionTarget" ? MonitorIcon : CloudIcon;
            return (
              <SelectItem key={item.environmentId} value={item.environmentId}>
                <span className="flex min-w-0 items-center gap-2">
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{item.label}</span>
                  {item.connection.phase !== "connected" ? (
                    <span className="text-xs text-muted-foreground">
                      {connectionStatusText(item.connection)}
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
      <Select
        modal={false}
        value={projectId ?? "global"}
        items={[
          { value: "global", label: "Environment skills" },
          ...environmentProjects.map((item) => ({ value: item.id, label: item.title })),
        ]}
        onValueChange={(value) => {
          const next = environmentProjects.find((item) => item.id === value);
          setSelection({ environmentId, projectId: next?.id ?? null });
        }}
      >
        <SelectTrigger
          variant="ghost"
          size="xs"
          aria-label="Project"
          title={project?.workspaceRoot}
          className="min-w-0 max-w-full font-medium sm:max-w-80"
        >
          {project ? (
            <FolderIcon className="size-3 shrink-0" />
          ) : (
            <GlobeIcon className="size-3 shrink-0" />
          )}
          <SelectValue className="truncate">{project?.title ?? "Environment skills"}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="global">
            <span className="inline-flex items-center gap-2">
              <GlobeIcon className="size-3.5 shrink-0" />
              Environment skills
            </span>
          </SelectItem>
          {environmentProjects.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              <span className="flex min-w-0 items-center gap-2">
                <FolderIcon className="size-3.5 shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{item.title}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {item.workspaceRoot}
                  </span>
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {environment && environment.connection.phase !== "connected" ? (
        <span role="status" className="px-2 text-xs text-muted-foreground">
          {connectionStatusText(environment.connection)}
        </span>
      ) : null}
    </div>
  );
  return (
    <SkillsPageContent
      key={`${environmentId}:${projectId}`}
      prepared={connection}
      projectId={projectId}
      project={project}
      selectors={selectors}
    />
  );
}

function SkillsPageContent({
  prepared,
  projectId,
  project,
  selectors,
}: {
  prepared: PreparedConnection | null;
  projectId: ProjectId | null;
  project: SkillProject | undefined;
  selectors: ReactNode;
}) {
  const catalogAtom = useMemo(
    () =>
      prepared === null
        ? null
        : connectionAtomRuntime
            .atom(fetchEnvironmentSkills(prepared, projectId === null ? {} : { projectId }))
            .pipe(Atom.setIdleTTL(60_000)),
    [prepared, projectId],
  );
  const catalog = useEnvironmentQuery(catalogAtom);
  const skills = catalog.data?.skills ?? EMPTY_SKILLS;
  const catalogError =
    prepared === null ? "Connect to this environment to inspect its skills." : catalog.error;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Omit<SkillCatalogFilters, "query">>({
    instanceId: "all",
    status: "all",
    invocation: "all",
    scope: "all",
  });
  const deferredQuery = useDeferredValue(query);
  const filteredSkills = useMemo(
    () => filterSkillCatalog(skills, { ...filters, query: deferredQuery }),
    [skills, filters, deferredQuery],
  );
  const providerOptions = useMemo(
    () => [
      ...new Map(
        skills.flatMap((skill) =>
          skill.installations.map(
            (entry) =>
              [
                entry.instanceId,
                { value: entry.instanceId, label: `${entry.providerName} (${entry.instanceId})` },
              ] as const,
          ),
        ),
      ).values(),
    ],
    [skills],
  );
  const scopeOptions = useMemo(
    () =>
      [
        ...new Set(
          skills.flatMap((skill) =>
            skill.installations.map((entry) => entry.scope ?? "unspecified"),
          ),
        ),
      ].map((value) => ({ value, label: value })),
    [skills],
  );

  const selected = useMemo(
    () =>
      filteredSkills.find((skill) => skillKey(skill) === selectedKey) ?? filteredSkills[0] ?? null,
    [filteredSkills, selectedKey],
  );

  const detailAtom = useMemo(
    () =>
      prepared === null || selected === null
        ? null
        : connectionAtomRuntime
            .atom(
              fetchEnvironmentSkill(prepared, projectId === null ? {} : { projectId }, selected),
            )
            .pipe(Atom.setIdleTTL(60_000)),
    [prepared, projectId, selected],
  );
  const detail = useEnvironmentQuery(detailAtom);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3">
            <WorkspaceBreadcrumb ariaLabel="Skills breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1>Skills</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <Button
              className="ms-auto"
              size="xs"
              variant="ghost"
              disabled={prepared === null || catalog.isPending}
              onClick={catalog.refresh}
            >
              <RefreshCwIcon className="size-3.5" />
              {catalog.isPending ? "Refreshing" : "Refresh"}
            </Button>
          </div>
        </WorkspacePageHeader>

        {selectors}
        {catalog.data?.issues.map((issue) => (
          <p
            key={issue.instanceId}
            role="status"
            className="px-5 py-2 text-sm text-muted-foreground"
          >
            {issue.providerName} ({issue.instanceId}): {issue.message}
          </p>
        ))}
        {catalogError !== null ? (
          <p role="alert" className="px-5 py-3 text-sm text-destructive-foreground">
            {catalogError}
          </p>
        ) : null}
        <div className="grid min-h-0 flex-1 border-t border-border lg:grid-cols-[19rem_minmax(0,1fr)]">
          <aside
            className={cn(
              "min-h-0 min-w-0 flex-col lg:flex lg:border-e lg:border-border",
              showDetail ? "hidden" : "flex",
            )}
          >
            <div className="space-y-3 border-b border-border/65 p-3">
              <InputGroup>
                <InputGroupAddon>
                  <SearchIcon aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  size="compact"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Search skills"
                  aria-label="Search skills"
                />
              </InputGroup>
              <SkillFilter
                label="Provider instance"
                value={filters.instanceId}
                options={[{ value: "all", label: "All provider instances" }, ...providerOptions]}
                onChange={(instanceId) => setFilters({ ...filters, instanceId })}
              />
              <SkillFilter
                label="Enabled status"
                value={filters.status}
                options={[
                  { value: "all", label: "All statuses" },
                  { value: "enabled", label: "Enabled" },
                  { value: "disabled", label: "Disabled" },
                ]}
                onChange={(status) => {
                  if (status === "all" || status === "enabled" || status === "disabled")
                    setFilters({ ...filters, status });
                }}
              />
              <SkillFilter
                label="Invocation"
                value={filters.invocation}
                options={[
                  { value: "all", label: "Any invocation policy" },
                  { value: "user", label: "User can invoke" },
                  { value: "agent", label: "Agent can invoke" },
                  { value: "both", label: "User and agent" },
                  { value: "neither", label: "Neither" },
                ]}
                onChange={(invocation) => {
                  if (
                    invocation === "all" ||
                    invocation === "user" ||
                    invocation === "agent" ||
                    invocation === "both" ||
                    invocation === "neither"
                  )
                    setFilters({ ...filters, invocation });
                }}
              />
              <SkillFilter
                label="Skill scope"
                value={filters.scope}
                options={[{ value: "all", label: "All scopes" }, ...scopeOptions]}
                onChange={(scope) => setFilters({ ...filters, scope })}
              />
            </div>

            <ScrollArea className="min-h-0 flex-1" scrollFade>
              {catalog.isPending && skills.length === 0 ? (
                <SkillsLoading />
              ) : filteredSkills.length > 0 ? (
                <div className="space-y-1 p-2">
                  {filteredSkills.map((skill) => (
                    <SkillListItem
                      key={skillKey(skill)}
                      skill={skill}
                      selected={selected !== null && skillKey(skill) === skillKey(selected)}
                      onSelect={() => {
                        setSelectedKey(skillKey(skill));
                        setShowDetail(true);
                      }}
                    />
                  ))}
                </div>
              ) : (
                <Empty className="min-h-72">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <SearchIcon />
                    </EmptyMedia>
                    <EmptyTitle>
                      {catalogError !== null
                        ? "Could not load skills"
                        : skills.length === 0
                          ? "No skills installed"
                          : "No matches"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {catalogError !== null
                        ? "Refresh to try again."
                        : skills.length === 0
                          ? "Install skills on this environment, then refresh."
                          : "Try another search or filter."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </ScrollArea>
          </aside>

          <div className={cn("min-h-0 min-w-0 flex-col lg:flex", showDetail ? "flex" : "hidden")}>
            <div className="border-b border-border p-2 lg:hidden">
              <Button variant="ghost" size="sm" onClick={() => setShowDetail(false)}>
                <ArrowLeftIcon className="size-4" /> Back to skills
              </Button>
            </div>
            <ScrollArea
              key={selected ? skillKey(selected) : "empty"}
              className="min-h-0 min-w-0 flex-1"
              scrollFade
            >
              {detail.isPending ? (
                <SkillsLoading />
              ) : detail.data !== null ? (
                <SkillDetailView detail={detail.data} project={project} />
              ) : detail.error !== null ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <BookOpenTextIcon />
                    </EmptyMedia>
                    <EmptyTitle>Could not read this skill</EmptyTitle>
                    <EmptyDescription>{detail.error}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
            </ScrollArea>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function SkillFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      modal={false}
      value={value}
      items={options}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
