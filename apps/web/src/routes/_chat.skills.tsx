import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, BoxIcon, LoaderIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";

import type { SkillMetadata, SkillSearchResultEntry } from "@t3tools/contracts";
import { isElectron } from "../env";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { SidebarInset } from "~/components/ui/sidebar";
import { OpenAI, ClaudeAI, Gemini, CursorIcon, OpenCodeIcon, type Icon } from "../components/Icons";
import {
  skillsListQueryOptions,
  skillsToggleMutationOptions,
  skillsSearchQueryOptions,
  skillsInstallMutationOptions,
  skillsUninstallMutationOptions,
  skillsReadContentQueryOptions,
} from "../lib/skillsReactQuery";
import { toastManager } from "../components/ui/toast";

const ChatMarkdown = lazy(() => import("../components/ChatMarkdown"));

// ── Deterministic color for skill icons ─────────────────────────────

const SKILL_COLORS = [
  "text-blue-500",
  "text-violet-500",
  "text-emerald-500",
  "text-amber-500",
  "text-rose-500",
  "text-cyan-500",
  "text-indigo-500",
  "text-teal-500",
  "text-orange-500",
  "text-pink-500",
];

function skillColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return SKILL_COLORS[Math.abs(hash) % SKILL_COLORS.length]!;
}

const PLATFORM_ICONS: Record<string, Icon> = {
  Codex: OpenAI,
  "Claude Code": ClaudeAI,
  Gemini: Gemini,
  Cursor: CursorIcon,
  OpenCode: OpenCodeIcon,
};

function formatSkillDisplayName(name: string): string {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// ── Skill Card ──────────────────────────────────────────────────────

function SkillCard({
  skill,
  onClick,
  onToggle,
  isToggling,
  onUninstall,
  isUninstalling,
}: {
  skill: SkillMetadata;
  onClick: () => void;
  onToggle: (skillName: string, enabled: boolean) => void;
  isToggling: boolean;
  onUninstall: (skillName: string) => void;
  isUninstalling: boolean;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent/50">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
        onClick={onClick}
      >
        <BoxIcon className={`mt-0.5 size-5 shrink-0 ${skillColor(skill.name)}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-foreground">
              {formatSkillDisplayName(skill.name)}
            </p>
            {skill.agents.map((agent) => {
              const PlatformIcon = PLATFORM_ICONS[agent];
              return PlatformIcon ? (
                <PlatformIcon
                  key={agent}
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-label={agent}
                />
              ) : (
                <span
                  key={agent}
                  className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  {agent}
                </span>
              );
            })}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          checked={skill.enabled}
          onCheckedChange={(checked) => onToggle(skill.name, Boolean(checked))}
          disabled={isToggling}
          aria-label={`Toggle ${skill.name}`}
        />
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          onClick={() => onUninstall(skill.name)}
          disabled={isUninstalling}
          aria-label={`Uninstall ${skill.name}`}
        >
          {isUninstalling ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <Trash2Icon className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

// ── Search Result Card ──────────────────────────────────────────────

function SearchResultCard({
  result,
  onInstall,
  isInstalling,
}: {
  result: SkillSearchResultEntry;
  onInstall: (source: string, skillName: string) => void;
  isInstalling: boolean;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
      <BoxIcon className={`mt-0.5 size-5 shrink-0 ${skillColor(result.name)}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          {formatSkillDisplayName(result.name)}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{result.source}</p>
        <p className="mt-0.5 text-[10px] text-muted-foreground/60">{result.installs}</p>
      </div>
      <Button
        size="xs"
        variant="outline"
        disabled={isInstalling}
        onClick={() => onInstall(result.source, result.name)}
      >
        {isInstalling ? <LoaderIcon className="size-3 animate-spin" /> : "Install"}
      </Button>
    </div>
  );
}

// ── Skill Detail View ───────────────────────────────────────────────

function SkillDetailView({
  skill,
  onBack,
  onToggle,
  isToggling,
  onUninstall,
  isUninstalling,
}: {
  skill: SkillMetadata;
  onBack: () => void;
  onToggle: (skillName: string, enabled: boolean) => void;
  isToggling: boolean;
  onUninstall: (skillName: string) => void;
  isUninstalling: boolean;
}) {
  const contentQuery = useQuery(skillsReadContentQueryOptions(skill.name));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onBack}
          aria-label="Back to skills"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <BoxIcon className={`size-5 shrink-0 ${skillColor(skill.name)}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">
              {formatSkillDisplayName(skill.name)}
            </h2>
            {skill.agents.map((agent) => {
              const PlatformIcon = PLATFORM_ICONS[agent];
              return PlatformIcon ? (
                <PlatformIcon
                  key={agent}
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-label={agent}
                />
              ) : (
                <span
                  key={agent}
                  className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  {agent}
                </span>
              );
            })}
          </div>
          {skill.description && (
            <p className="text-xs text-muted-foreground">{skill.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Switch
            checked={skill.enabled}
            onCheckedChange={(checked) => onToggle(skill.name, Boolean(checked))}
            disabled={isToggling}
            aria-label={`Toggle ${skill.name}`}
          />
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            onClick={() => onUninstall(skill.name)}
            disabled={isUninstalling}
            aria-label={`Uninstall ${skill.name}`}
          >
            {isUninstalling ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <Trash2Icon className="size-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl">
          {contentQuery.isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              Loading skill content...
            </div>
          ) : contentQuery.isError ? (
            <div className="rounded-xl border border-border bg-card p-6 text-center">
              <p className="text-sm text-destructive">Failed to load skill content.</p>
              <Button size="xs" variant="outline" className="mt-3" onClick={() => void contentQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : contentQuery.data?.content ? (
            <Suspense
              fallback={
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <LoaderIcon className="size-4 animate-spin" />
                  Rendering...
                </div>
              }
            >
              <ChatMarkdown text={contentQuery.data.content} cwd={undefined} />
            </Suspense>
          ) : (
            <p className="py-8 text-sm text-muted-foreground">No content available for this skill.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main View ───────────────────────────────────────────────────────

function SkillsRouteView() {
  const queryClient = useQueryClient();
  const skillsQuery = useQuery(skillsListQueryOptions());
  const toggleMutation = useMutation(skillsToggleMutationOptions({ queryClient }));
  const installMutation = useMutation(skillsInstallMutationOptions({ queryClient }));
  const uninstallMutation = useMutation(skillsUninstallMutationOptions({ queryClient }));

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (search.length < 2) {
      setDebouncedSearch("");
      return;
    }
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  const searchQuery = useQuery(skillsSearchQueryOptions(debouncedSearch));

  const handleToggle = (skillName: string, enabled: boolean) => {
    toggleMutation.mutate({ skillName, enabled });
  };

  const handleUninstall = (skillName: string) => {
    uninstallMutation.mutate(
      { skillName },
      {
        onSuccess: (result) => {
          if (result.success) {
            setSelectedSkillName(null);
            toastManager.add({ type: "success", title: "Skill uninstalled", description: result.message });
          } else {
            toastManager.add({ type: "error", title: "Uninstall failed", description: result.message });
          }
        },
      },
    );
  };

  const handleInstall = (source: string, skillName: string) => {
    installMutation.mutate(
      { source, skillName },
      {
        onSuccess: (result) => {
          if (result.success) {
            toastManager.add({ type: "success", title: "Skill installed", description: result.message });
          } else {
            toastManager.add({ type: "error", title: "Install failed", description: result.message });
          }
        },
      },
    );
  };

  const skills = skillsQuery.data?.skills;
  const filteredSkills = useMemo(() => {
    if (!skills) return [];
    if (!search) return skills;
    const lower = search.toLowerCase();
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(lower) ||
        skill.description.toLowerCase().includes(lower),
    );
  }, [skills, search]);

  // Filter out already-installed skills from search results
  const installedNames = useMemo(() => {
    if (!skills) return new Set<string>();
    return new Set(skills.map((s) => s.name));
  }, [skills]);
  const onlineResults = useMemo(() => {
    const results = searchQuery.data?.skills;
    if (!results) return [];
    return results.filter((r) => !installedNames.has(r.name));
  }, [searchQuery.data?.skills, installedNames]);

  // Resolve the selected skill from the current skills list
  const selectedSkill = useMemo(() => {
    if (!selectedSkillName || !skills) return null;
    return skills.find((s) => s.name === selectedSkillName) ?? null;
  }, [selectedSkillName, skills]);

  // If the selected skill was uninstalled, go back to list
  useEffect(() => {
    if (selectedSkillName && skills && !skills.some((s) => s.name === selectedSkillName)) {
      setSelectedSkillName(null);
    }
  }, [selectedSkillName, skills]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Skills
            </span>
          </div>
        )}

        {selectedSkill ? (
          <SkillDetailView
            skill={selectedSkill}
            onBack={() => setSelectedSkillName(null)}
            onToggle={handleToggle}
            isToggling={
              toggleMutation.isPending &&
              toggleMutation.variables?.skillName === selectedSkill.name
            }
            onUninstall={handleUninstall}
            isUninstalling={
              uninstallMutation.isPending &&
              uninstallMutation.variables?.skillName === selectedSkill.name
            }
          />
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
              <header className="space-y-1">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">Skills</h1>
                <p className="text-sm text-muted-foreground">
                  Give your agent superpowers.
                </p>
              </header>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="inline-flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                  onClick={() => void skillsQuery.refetch()}
                  disabled={skillsQuery.isFetching}
                  aria-label="Refresh skills"
                >
                  <RefreshCwIcon
                    className={`size-3.5 ${skillsQuery.isFetching ? "animate-spin" : ""}`}
                  />
                </button>
                <div className="relative flex-1">
                  <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search installed & skills.sh..."
                    className="pl-8"
                  />
                </div>
              </div>

              {/* Installed Skills */}
              <section>
                <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                  Installed
                </h2>

                {skillsQuery.isLoading ? (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {Array.from({ length: 6 }, (_, i) => (
                      <div
                        key={i}
                        className="h-[76px] animate-pulse rounded-xl border border-border bg-card"
                      />
                    ))}
                  </div>
                ) : skillsQuery.isError ? (
                  <div className="rounded-xl border border-border bg-card p-6 text-center">
                    <p className="text-sm text-destructive">Failed to load skills.</p>
                    <Button size="xs" variant="outline" className="mt-3" onClick={() => void skillsQuery.refetch()}>
                      Retry
                    </Button>
                  </div>
                ) : filteredSkills.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border bg-card px-6 py-8 text-center">
                    <p className="text-sm text-muted-foreground">
                      {search ? "No skills match your search." : "No skills installed yet."}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {filteredSkills.map((skill) => (
                      <SkillCard
                        key={skill.name}
                        skill={skill}
                        onClick={() => setSelectedSkillName(skill.name)}
                        onToggle={handleToggle}
                        isToggling={
                          toggleMutation.isPending &&
                          toggleMutation.variables?.skillName === skill.name
                        }
                        onUninstall={handleUninstall}
                        isUninstalling={
                          uninstallMutation.isPending &&
                          uninstallMutation.variables?.skillName === skill.name
                        }
                      />
                    ))}
                  </div>
                )}
              </section>

              {/* Online Skills from skills.sh */}
              {debouncedSearch.length >= 2 && (
                <section>
                  <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                    From skills.sh
                  </h2>

                  {searchQuery.isLoading ? (
                    <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                      <LoaderIcon className="size-3 animate-spin" />
                      Searching skills.sh...
                    </div>
                  ) : searchQuery.isError ? (
                    <p className="py-4 text-xs text-destructive">
                      Search failed. Check your internet connection and try again.
                    </p>
                  ) : onlineResults.length > 0 ? (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      {onlineResults.map((result) => (
                        <SearchResultCard
                          key={`${result.source}:${result.name}`}
                          result={result}
                          onInstall={handleInstall}
                          isInstalling={
                            installMutation.isPending &&
                            installMutation.variables?.source === result.source
                          }
                        />
                      ))}
                    </div>
                  ) : searchQuery.data ? (
                    <p className="py-4 text-xs text-muted-foreground">
                      {searchQuery.data.skills.length > 0
                        ? "All matching skills are already installed."
                        : `No skills found for \u201c${debouncedSearch}\u201d.`}
                    </p>
                  ) : null}
                </section>
              )}
            </div>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/skills")({
  component: SkillsRouteView,
});
