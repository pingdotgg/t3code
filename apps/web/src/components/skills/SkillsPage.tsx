import type {
  AgentSkillDetail,
  AgentSkillScope,
  AgentSkillSummary,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import {
  BookOpenTextIcon,
  ArrowLeftIcon,
  ExternalLinkIcon,
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
import { ToggleGroup, Toggle } from "../ui/toggle-group";

type ScopeFilter = "all" | AgentSkillScope;
type SkillProject = { readonly title: string; readonly workspaceRoot: string };

const EMPTY_SKILLS: ReadonlyArray<AgentSkillSummary> = [];

const skillKey = (skill: Pick<AgentSkillSummary, "scope" | "name">): string =>
  `${skill.scope}:${skill.name}`;

function sourceHref(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

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
  scope: AgentSkillScope;
  project?: SkillProject | undefined;
}) {
  return (
    <Badge
      size="sm"
      variant="secondary"
      title={scope === "project" ? project?.workspaceRoot : undefined}
    >
      {scope === "global" ? "Global" : project ? `Project · ${project.title}` : "Project"}
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
        <span className="truncate text-sm font-medium text-foreground">{skill.name}</span>
        <ScopeBadge scope={skill.scope} />
      </span>
      {skill.description ? (
        <span className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {skill.description}
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
  const href = sourceHref(detail.sourceUrl);
  return (
    <article className="min-w-0">
      <WorkspacePageContainer className="min-w-0">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 break-words text-lg font-semibold">{detail.name}</h2>
            <ScopeBadge scope={detail.scope} project={project} />
          </div>
          {detail.description ? (
            <p className="text-sm leading-6 text-muted-foreground">{detail.description}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 pt-1" aria-label="Linked providers">
            <span className="me-1 text-xs text-muted-foreground">Linked providers</span>
            {detail.agents.length ? (
              detail.agents.map((agent) => (
                <Badge key={agent} variant="outline">
                  {agent}
                </Badge>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">None</span>
            )}
          </div>
        </header>

        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            Installation details
          </summary>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 leading-5">
            <dt>Path</dt>
            <dd className="break-all font-mono">{detail.path}</dd>
            <dt>Source</dt>
            <dd className="min-w-0 break-words">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline underline-offset-4"
                >
                  {detail.source ?? detail.sourceUrl}
                  <ExternalLinkIcon className="size-3 shrink-0" />
                </a>
              ) : (
                (detail.source ?? "Local skill")
              )}
            </dd>
          </dl>
        </details>

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
          { value: "global", label: "Global skills only" },
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
          <SelectValue className="truncate">{project?.title ?? "Global skills only"}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="global">
            <span className="inline-flex items-center gap-2">
              <GlobeIcon className="size-3.5 shrink-0" />
              Global skills only
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
  const skills = catalog.data ?? EMPTY_SKILLS;
  const catalogError =
    prepared === null ? "Connect to this environment to inspect its skills." : catalog.error;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  const filteredSkills = useMemo(
    () =>
      skills.filter((skill) => {
        if (scope !== "all" && skill.scope !== scope) return false;
        if (!deferredQuery) return true;
        return [skill.name, skill.description, skill.path, skill.source ?? "", ...skill.agents]
          .join(" ")
          .toLowerCase()
          .includes(deferredQuery);
      }),
    [skills, deferredQuery, scope],
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
              {projectId !== null ? (
                <ToggleGroup
                  variant="segmented"
                  className="w-full"
                  value={[scope]}
                  onValueChange={(values) => {
                    const next = values[0];
                    if (next === "all" || next === "project" || next === "global") setScope(next);
                  }}
                  aria-label="Filter skill scope"
                >
                  {(["all", "project", "global"] as const).map((value) => (
                    <Toggle key={value} value={value} className="flex-1 capitalize">
                      {value}
                    </Toggle>
                  ))}
                </ToggleGroup>
              ) : null}
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
                          : scope !== "all" && !query
                            ? `No ${scope} skills`
                            : "No matches"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {catalogError !== null
                        ? "Refresh to try again."
                        : skills.length === 0
                          ? "Install skills on this environment, then refresh."
                          : "Try another search or scope."}
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
