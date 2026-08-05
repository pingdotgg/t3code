import { useMemo, useState } from "react";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ServerSkillCatalogEntry, ServerSkillCatalogIssue } from "@t3tools/contracts";

import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Skeleton } from "../components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { isElectron } from "../env";

const EMPTY_SKILLS: ReadonlyArray<ServerSkillCatalogEntry> = [];
const EMPTY_ISSUES: ReadonlyArray<ServerSkillCatalogIssue> = [];

function useSkillsCatalogQuery() {
  return useQuery({
    queryKey: ["server", "skills"],
    queryFn: async () => {
      const api = readLocalApi();
      if (!api) {
        throw new Error("Local API not found");
      }
      return api.server.listSkills();
    },
  });
}

function skillSearchText(skill: ServerSkillCatalogEntry): string {
  return [
    skill.id,
    skill.name,
    skill.displayName,
    skill.description ?? "",
    skill.shortDescription ?? "",
    skill.prompt ?? "",
    skill.canonicalPath,
    ...skill.paths,
    ...skill.installations.flatMap((installation) => [
      installation.agentName,
      installation.agentId,
      installation.source,
      installation.path,
    ]),
  ]
    .join(" ")
    .toLowerCase();
}

function filterSkills(
  skills: ReadonlyArray<ServerSkillCatalogEntry>,
  query: string,
): ReadonlyArray<ServerSkillCatalogEntry> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return skills;
  }
  return skills.filter((skill) => skillSearchText(skill).includes(normalizedQuery));
}

function installationSourceLabel(
  source: ServerSkillCatalogEntry["installations"][number]["source"],
): string {
  switch (source) {
    case "primary":
      return "installed";
    case "readable":
      return "readable";
    case "shared":
      return "shared";
  }
}

function installationSourceDescription(
  source: ServerSkillCatalogEntry["installations"][number]["source"],
): string {
  switch (source) {
    case "primary":
      return "This skill is installed directly in this agent's own global skills directory.";
    case "readable":
      return "This agent can use this skill from another global skills directory it knows how to read.";
    case "shared":
      return "This skill lives in the shared ~/.agents/skills directory used by compatible agents.";
  }
}

function HelpTooltip({
  children,
  description,
}: {
  readonly children: React.ReactNode;
  readonly description: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex cursor-help" />}>
        {children}
      </TooltipTrigger>
      <TooltipPopup className="max-w-72">{description}</TooltipPopup>
    </Tooltip>
  );
}

function DetailField({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      <div className="mt-1 min-w-0 text-xs text-foreground">{children}</div>
    </div>
  );
}

function PathValue({ path }: { readonly path: string }) {
  return (
    <div className="truncate rounded-md bg-muted/48 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
      {path}
    </div>
  );
}

function SkillsHeader({
  count,
  isFetching,
  onRefresh,
}: {
  readonly count: number;
  readonly isFetching: boolean;
  readonly onRefresh: () => void;
}) {
  return (
    <header
      className={cn(
        "shrink-0 border-b border-border px-3 py-2 sm:px-5",
        isElectron &&
          "drag-region h-[52px] wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
      )}
    >
      <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
        <SidebarTrigger className="no-drag size-7 shrink-0" />
        <SparklesIcon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Skills</span>
        <Badge variant="outline" size="sm">
          {count}
        </Badge>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="ml-auto"
          disabled={isFetching}
          onClick={onRefresh}
        >
          <RefreshCwIcon className={cn("size-3.5", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>
    </header>
  );
}

function SkillCard({ skill }: { readonly skill: ServerSkillCatalogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const description = skill.description ?? skill.shortDescription ?? "No description provided.";
  const prompt = skill.prompt ?? "No prompt body found in SKILL.md.";

  return (
    <article className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xs">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-medium">{skill.displayName}</h2>
            {skill.hasPathConflict ? (
              <HelpTooltip description="Multiple different directories use the same skill ID. t3code shows one catalog row, but the underlying files may not be identical. Check the path list before relying on this skill.">
                <Badge variant="warning" size="sm">
                  path conflict
                </Badge>
              </HelpTooltip>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {skill.shortDescription ?? skill.description ?? "No description provided."}
          </p>
        </div>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="shrink-0"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          Details
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
          />
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {skill.installations.map((installation) => (
          <HelpTooltip
            key={`${installation.agentId}:${installation.path}:${installation.source}`}
            description={`${installationSourceDescription(installation.source)} Path: ${installation.path}`}
          >
            <Badge variant={installation.source === "primary" ? "secondary" : "outline"} size="sm">
              {installation.agentName}
              {installation.source !== "primary"
                ? ` (${installationSourceLabel(installation.source)})`
                : ""}
            </Badge>
          </HelpTooltip>
        ))}
      </div>
      <HelpTooltip description="Canonical path is the resolved filesystem location for this skill after following symlinks.">
        <div className="mt-3">
          <PathValue path={skill.canonicalPath} />
        </div>
      </HelpTooltip>
      {expanded ? (
        <div className="mt-4 border-t border-border pt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailField label="Skill ID">
              <code className="font-mono text-[11px]">{skill.id}</code>
            </DetailField>
            <DetailField label="Name">
              <code className="font-mono text-[11px]">{skill.name}</code>
            </DetailField>
            <DetailField label="Description">
              <p className="text-muted-foreground">{description}</p>
            </DetailField>
            <DetailField label="Prompt length">
              <span className="text-muted-foreground">
                {skill.prompt
                  ? `${skill.prompt.length.toLocaleString()} characters`
                  : "No prompt body"}
              </span>
            </DetailField>
            <DetailField label="Availability">
              <div className="flex flex-wrap gap-1.5">
                {skill.installations.map((installation) => (
                  <Badge
                    key={`detail:${installation.agentId}:${installation.path}:${installation.source}`}
                    variant={installation.source === "primary" ? "secondary" : "outline"}
                    size="sm"
                  >
                    {installation.agentName} - {installationSourceLabel(installation.source)}
                  </Badge>
                ))}
              </div>
            </DetailField>
          </div>
          <div className="mt-4 grid gap-4">
            <DetailField label="Canonical path">
              <PathValue path={skill.canonicalPath} />
            </DetailField>
            <DetailField label="Full skill prompt">
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/32 p-3 font-mono text-[11px] leading-relaxed text-foreground">
                {prompt}
              </pre>
            </DetailField>
            <DetailField label="All discovered paths">
              <div className="grid gap-1.5">
                {skill.paths.map((path) => (
                  <PathValue key={path} path={path} />
                ))}
              </div>
            </DetailField>
            <DetailField label="Installations">
              <div className="grid gap-2">
                {skill.installations.map((installation) => (
                  <div
                    key={`install:${installation.agentId}:${installation.path}:${installation.source}`}
                    className="rounded-lg border border-border bg-muted/24 p-2"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium">{installation.agentName}</span>
                      <Badge variant="outline" size="sm">
                        {installation.agentId}
                      </Badge>
                      <Badge
                        variant={installation.source === "primary" ? "secondary" : "outline"}
                        size="sm"
                      >
                        {installationSourceLabel(installation.source)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {installationSourceDescription(installation.source)}
                    </p>
                    <div className="mt-2">
                      <PathValue path={installation.path} />
                    </div>
                  </div>
                ))}
              </div>
            </DetailField>
            {skill.hasPathConflict ? (
              <Alert variant="warning">
                <AlertTriangleIcon />
                <AlertTitle>Path conflict</AlertTitle>
                <AlertDescription>
                  Multiple directories share the same skill ID. t3code groups them into one row so
                  you can inspect all paths, but the files may differ.
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function SkillsSkeleton() {
  return (
    <div className="grid gap-3">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="rounded-xl border border-border bg-card p-4">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="mt-2 h-3 w-2/3" />
          <div className="mt-3 flex gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SkillsPage() {
  const [query, setQuery] = useState("");
  const catalogQuery = useSkillsCatalogQuery();
  const skills = catalogQuery.data?.skills ?? EMPTY_SKILLS;
  const filteredSkills = useMemo(() => filterSkills(skills, query), [query, skills]);
  const issues = catalogQuery.data?.issues ?? EMPTY_ISSUES;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        <SkillsHeader
          count={skills.length}
          isFetching={catalogQuery.isFetching}
          onRefresh={() => void catalogQuery.refetch()}
        />
        <main className="min-h-0 flex-1 overflow-auto px-3 py-4 sm:px-5">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              System-wide skills discovered from global agent configuration directories. Hover
              badges and paths for details about how each skill is available.
            </p>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                placeholder="Search skills, agents, descriptions, or paths..."
                className="pl-9"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
            {issues.length > 0 ? (
              <Alert variant="warning">
                <AlertTriangleIcon />
                <AlertTitle>Some skill locations could not be read</AlertTitle>
                <AlertDescription>
                  <div className="max-h-28 overflow-auto font-mono text-[11px]">
                    {issues.slice(0, 8).map((catalogIssue) => (
                      <div key={`${catalogIssue.kind}:${catalogIssue.path}`}>
                        {catalogIssue.path}: {catalogIssue.message}
                      </div>
                    ))}
                    {issues.length > 8 ? <div>+{issues.length - 8} more</div> : null}
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}
            {catalogQuery.isLoading ? (
              <SkillsSkeleton />
            ) : catalogQuery.isError ? (
              <Alert variant="error">
                <AlertTriangleIcon />
                <AlertTitle>Unable to load skills</AlertTitle>
                <AlertDescription>{String(catalogQuery.error)}</AlertDescription>
              </Alert>
            ) : filteredSkills.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-8 text-center">
                <SparklesIcon className="mx-auto size-8 text-muted-foreground/70" />
                <h2 className="mt-3 text-sm font-medium">
                  {skills.length === 0 ? "No skills found" : "No matching skills"}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {skills.length === 0
                    ? "Add skills to global agent directories like ~/.agents/skills or ~/.claude/skills."
                    : "Try a different search term."}
                </p>
              </div>
            ) : (
              <div className="grid gap-3">
                {filteredSkills.map((skill) => (
                  <SkillCard key={skill.id} skill={skill} />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/skills")({
  beforeLoad: async ({ context }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: SkillsPage,
});
