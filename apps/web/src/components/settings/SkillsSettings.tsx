import type { ServerProvider } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { BookOpenIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAfterDelay } from "../../hooks/useAfterDelay";
import { cn } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { BulkBar, ConfirmPlan } from "./SkillBulkBar";
import { SkillDetail } from "./SkillDetail";
import { SkillSection, StandardInfo } from "./SkillList";
import type { PlaceOptions } from "./SkillUseIn";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  attention,
  describeResult,
  ingestSkills,
  installedAgents,
  matchesQuery,
  sendInBatches,
  skillsEnvironment,
  skillsToCheckWithGit,
  unreadableNote,
  withGitNote,
  type ProjectOption,
  type Skill,
  type SkillPlan,
  type SkillsContext,
} from "./SkillsSettings.logic";

const NO_PROVIDERS: readonly ServerProvider[] = [];
/** A load that finishes sooner than this shows no placeholder at all. */
const SKELETON_DELAY_MS = 150;
const LOAD_ERROR = "Couldn't read this environment's skill folders.";
const CHANGE_ERROR = "Couldn't change the skills here.";

type PickedProject = { id: string; label: string; cwd: string };
type Loaded = ReturnType<typeof ingestSkills>;
type View = { kind: "list" } | { kind: "skill"; id: string };

export function SkillsSettings() {
  const { environment: scopedEnvironment, scope } = useSettingsScope();
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const environment = skillsEnvironment({
    connected: scopedEnvironment,
    scopeEnvironmentIds: scope.environmentIds,
    environments,
    primaryId,
  });
  // The settings scope picker at the top of the page decides what this page shows.
  const project =
    scope.kind === "checkout"
      ? scope.checkout
      : scope.kind === "project"
        ? scope.members.find((member) => member.environmentId === environment?.environmentId)
        : undefined;
  const projectName =
    scope.kind === "project" || scope.kind === "checkout" ? scope.group.displayName : "";
  const picked = useMemo<PickedProject | null>(
    () => (project ? { id: project.id, label: projectName, cwd: project.workspaceRoot } : null),
    [project, projectName],
  );
  const missingProject = (scope.kind === "project" || scope.kind === "checkout") && !project;
  // On a phone, an open skill gets the whole screen under its Back row.
  const [subpage, setSubpage] = useState(false);
  /** Rows have checkboxes, and a bar at the bottom acts on the ticked ones. */
  const [selecting, setSelecting] = useState(false);
  const canSelect = environment !== undefined && !missingProject && !subpage;
  return (
    <SettingsPageContainer width="expanded" hideScopeOnPhone={subpage}>
      <div className={cn("space-y-1", subpage && "hidden sm:block")}>
        <div className="flex items-center gap-2">
          <BookOpenIcon className="size-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Skills</h1>
          <StandardInfo />
          <span className="flex-1" />
          {canSelect && (
            <Button
              size="xs"
              variant={selecting ? "secondary" : "outline"}
              onClick={() => setSelecting((value) => !value)}
            >
              {selecting ? "Done" : "Select"}
            </Button>
          )}
        </div>
      </div>
      {!environment ? (
        <p className="text-sm text-muted-foreground">
          {scope.environmentIds.length > 0
            ? "This environment isn't available."
            : "Connect an environment to see its skills."}
        </p>
      ) : missingProject ? (
        <p className="text-sm text-muted-foreground">This project isn't on {environment.label}.</p>
      ) : (
        <EnvironmentSkills
          key={`${environment.environmentId}:${picked?.id ?? "global"}`}
          environment={environment}
          project={picked}
          selecting={selecting}
          onSubpageChange={setSubpage}
        />
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentSkills({
  environment,
  project,
  selecting,
  onSubpageChange,
}: {
  environment: ReturnType<typeof useEnvironments>["environments"][number];
  /** The project picked above the page, or null when none is. */
  project: PickedProject | null;
  /** Rows have checkboxes, and a bar at the bottom acts on the ticked ones. */
  selecting: boolean;
  /** True while a skill is open instead of the list. */
  onSubpageChange: (open: boolean) => void;
}) {
  const listSkills = useAtomCommand(serverEnvironment.listSkills, { reportFailure: false });
  const enableSkills = useAtomCommand(serverEnvironment.enableSkills, { reportFailure: false });
  const disableSkills = useAtomCommand(serverEnvironment.disableSkills, { reportFailure: false });
  const placeSkills = useAtomCommand(serverEnvironment.placeSkills, { reportFailure: false });
  const deleteSkills = useAtomCommand(serverEnvironment.deleteSkills, { reportFailure: false });
  const skillsTracked = useAtomCommand(serverEnvironment.skillsTracked, { reportFailure: false });
  // Reading the list needs no grant; each change needs its command's.
  const canEnable = useAtomValue(
    serverEnvironment.enableSkills.permissionAtom(environment.environmentId),
  );
  const canDisable = useAtomValue(
    serverEnvironment.disableSkills.permissionAtom(environment.environmentId),
  );
  const canPlace = useAtomValue(
    serverEnvironment.placeSkills.permissionAtom(environment.environmentId),
  );
  const canDelete = useAtomValue(
    serverEnvironment.deleteSkills.permissionAtom(environment.environmentId),
  );
  const allProjects = useProjects();
  const connected = environment.connection.phase === "connected";
  const providers = environment.serverConfig?.providers ?? NO_PROVIDERS;
  const cwd = project?.cwd ?? null;

  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  const [query, setQuery] = useState("");
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [detailReload, setDetailReload] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** A change that is waiting for the person to confirm it. */
  const [confirming, setConfirming] = useState<SkillPlan | null>(null);
  /** A change is being made and the list read again; nothing else can start meanwhile. */
  const [busy, setBusy] = useState(false);
  /** The controls that change skills are off while a change runs or the grant is missing. */
  const locked = busy || !(canEnable && canDisable && canPlace && canDelete);
  const [notice, setNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A new view starts at the top of the page.
  const show = useCallback((next: View) => {
    setView(next);
    rootRef.current?.closest("[data-settings-page-scroll]")?.scrollTo({ top: 0 });
  }, []);
  const openSkill = useCallback((id: string) => show({ kind: "skill", id }), [show]);

  // The server reads a fixed list of folders each time; no agent is asked to rescan.
  const load = useCallback(async () => {
    const result = await listSkills({
      environmentId: environment.environmentId,
      input: cwd ? { cwd } : {},
    });
    return result._tag === "Success" ? ingestSkills(result.value) : null;
  }, [listSkills, environment.environmentId, cwd]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void load()
      .then((loaded) => {
        if (cancelled) return;
        setData(loaded);
        setLoadError(loaded ? null : LOAD_ERROR);
      })
      .catch(() => {
        if (!cancelled) setLoadError(LOAD_ERROR);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, load]);

  const refresh = () => {
    setRefreshing(true);
    setLoadError(null);
    void load()
      .then((loaded) => {
        if (!mounted.current) return;
        if (!loaded) {
          setLoadError(LOAD_ERROR);
          return;
        }
        setData(loaded);
        show({ kind: "list" });
      })
      .catch(() => {
        if (mounted.current) setLoadError(LOAD_ERROR);
      })
      .finally(() => {
        if (mounted.current) setRefreshing(false);
      });
  };

  const skills = data?.skills ?? null;
  const installed = useMemo(
    () => (data ? installedAgents(providers, data.known) : []),
    [data, providers],
  );
  const ctx = useMemo<SkillsContext>(() => ({ installed }), [installed]);
  // The projects "Use in…" can name: the ones registered in this environment.
  const places = useMemo<PlaceOptions>(() => {
    const projects = allProjects
      .filter((entry) => entry.environmentId === environment.environmentId)
      .map((entry): ProjectOption => ({ cwd: entry.workspaceRoot, label: entry.title }))
      .toSorted((a, b) => a.label.localeCompare(b.label));
    const picked = project
      ? (projects.find((entry) => entry.cwd === project.cwd) ?? {
          cwd: project.cwd,
          label: project.label,
        })
      : null;
    return { picked, projects };
  }, [allProjects, environment.environmentId, project]);
  const loading = connected && skills === null && loadError === null;
  const showSkeleton = useAfterDelay(loading, SKELETON_DELAY_MS);

  const projectSkills = useMemo(
    () => (skills ?? []).filter((skill) => skill.scope === "project"),
    [skills],
  );
  const globalSkills = useMemo(
    () => (skills ?? []).filter((skill) => skill.scope === "global"),
    [skills],
  );
  const attentionIds = useMemo(
    () =>
      new Set((skills ?? []).filter((skill) => attention(skill, ctx) !== null).map((s) => s.id)),
    [skills, ctx],
  );
  const needle = query.trim().toLowerCase();
  // Memoized, so a row or group is only drawn again when what it shows changed.
  const narrow = useCallback(
    (list: readonly Skill[]) =>
      list.filter(
        (skill) => (!onlyAttention || attentionIds.has(skill.id)) && matchesQuery(skill, needle),
      ),
    [onlyAttention, attentionIds, needle],
  );
  const visibleProject = useMemo(() => narrow(projectSkills), [narrow, projectSkills]);
  const visibleGlobal = useMemo(() => narrow(globalSkills), [narrow, globalSkills]);

  const current = view.kind === "skill" ? skills?.find((skill) => skill.id === view.id) : undefined;
  // A view whose skill is gone (a refresh dropped it) falls back to the list.
  const skillView = current && data ? { skill: current, data } : null;
  const showList = !skillView;
  useEffect(() => {
    onSubpageChange(!showList);
    return () => onSubpageChange(false);
  }, [showList, onSubpageChange]);

  const toList = () => show({ kind: "list" });

  /**
   * Asks the server to make the change, then reads the folders again: the page shows what is on
   * disk, never what the change was expected to do.
   */
  const apply = async (plan: SkillPlan) => {
    setConfirming(null);
    setBusy(true);
    const { change } = plan;
    const base = { environmentId: environment.environmentId } as const;
    const scoped = cwd ? { cwd } : {};
    try {
      // The server takes a few hundred skills at a time, so a big change goes in batches.
      const { outcomes, failed } = await sendInBatches(change.skills, async (skills) => {
        const result =
          change.kind === "enable"
            ? await enableSkills({
                ...base,
                input: { ...scoped, skills, agents: change.agents },
              })
            : change.kind === "disable"
              ? await disableSkills({
                  ...base,
                  input: { ...scoped, skills, agents: change.agents },
                })
              : change.kind === "place"
                ? await placeSkills({ ...base, input: { ...scoped, skills, to: change.to } })
                : await deleteSkills({ ...base, input: { ...scoped, skills } });
        return result?._tag === "Success" ? result.value.outcomes : null;
      });
      // What was done before a batch failed is still told.
      setNotice(
        !failed
          ? describeResult(change, outcomes, ctx)
          : outcomes.length === 0
            ? CHANGE_ERROR
            : `${describeResult(change, outcomes, ctx)} ${CHANGE_ERROR}`,
      );
    } catch {
      setNotice(CHANGE_ERROR);
    }
    try {
      const loaded = await load();
      if (loaded) {
        setData(loaded);
        setLoadError(null);
      } else {
        setLoadError(LOAD_ERROR);
      }
    } catch {
      setLoadError(LOAD_ERROR);
    }
    setSelected(new Set());
    setBusy(false);
  };
  /**
   * A plan that needs confirming waits for the dialog; any other goes ahead. For a placement or
   * delete the dialog opens at once and git is asked meanwhile: the "undo with git" line appears
   * when the answer is in, and never when the check fails.
   */
  const runPlan = (plan: SkillPlan) => {
    if (!plan.confirmation) {
      void apply(plan);
      return;
    }
    setConfirming(plan);
    const skills = cwd ? skillsToCheckWithGit(plan) : null;
    if (!cwd || !skills) return;
    void (async () => {
      try {
        const result = await skillsTracked({
          environmentId: environment.environmentId,
          input: { cwd, skills },
        });
        if (result._tag !== "Success") return;
        const tracked = result.value.tracked;
        setConfirming((current) => (current === plan ? withGitNote(plan, tracked) : current));
      } catch {
        // No answer, no promise: the dialog stays as it was.
      }
    })();
  };
  // Rows are memoized, so they get one function that always calls the latest runPlan.
  const runPlanRef = useRef(runPlan);
  useEffect(() => {
    runPlanRef.current = runPlan;
  });
  const onPlan = useCallback((plan: SkillPlan) => runPlanRef.current(plan), []);
  const chosen = useMemo(
    () => (skills ?? []).filter((skill) => selected.has(skill.id)),
    [skills, selected],
  );
  const setSelection = useCallback((ids: readonly string[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  // Leaving Select mode leaves nothing ticked.
  const [wasSelecting, setWasSelecting] = useState(selecting);
  if (wasSelecting !== selecting) {
    setWasSelecting(selecting);
    if (!selecting) setSelected(new Set());
  }
  const offline = !connected;
  const empty = skills !== null && skills.length === 0;
  const emptyText = (total: number, none: string) =>
    total === 0
      ? none
      : onlyAttention && !needle
        ? "Nothing needs attention here."
        : "No matching skills.";

  return (
    <div ref={rootRef} className="min-w-0 space-y-4">
      {offline && (
        <p role="status" className="text-sm text-warning-foreground">
          This environment is offline.
        </p>
      )}
      {loadError && (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-warning-foreground"
        >
          {loadError}
          <Button size="xs" variant="outline" onClick={refresh}>
            Try again
          </Button>
        </p>
      )}

      {notice && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm break-words"
        >
          <span className="min-w-0 flex-1">{notice}</span>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
          >
            <XIcon />
          </Button>
        </p>
      )}

      {skillView && (
        <SkillDetail
          key={`${skillView.skill.id}:${detailReload}`}
          skill={skillView.skill}
          ctx={ctx}
          environmentId={environment.environmentId}
          projectRoot={cwd}
          places={places}
          busy={locked}
          onBack={toList}
          onPlan={runPlan}
          onReload={() => setDetailReload((count) => count + 1)}
        />
      )}
      {showList && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-full min-w-0 sm:flex-1">
              <Input
                aria-label="Search skills"
                placeholder="Search skills…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {/* The count depends on the list, so it waits for it instead of showing a false zero. */}
            {skills !== null && (
              <Button
                size="sm"
                variant={onlyAttention ? "secondary" : "outline"}
                aria-pressed={onlyAttention}
                onClick={() => setOnlyAttention((value) => !value)}
              >
                Needs attention ({attentionIds.size})
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={refreshing ? "Refreshing skills" : "Refresh skills"}
              disabled={loading || refreshing || offline}
              onClick={refresh}
            >
              <RefreshIcon refreshing={refreshing} />
            </Button>
          </div>

          {loading && (
            <p role="status" className="sr-only">
              Loading skills…
            </p>
          )}
          {showSkeleton && <SkillsSkeleton withProject={project !== null} />}

          {skills !== null && (
            <>
              {data && data.unreadable.length > 0 && (
                <p role="status" className="text-sm text-warning-foreground">
                  {unreadableNote(data.unreadable)}
                </p>
              )}
              {project && (
                <SkillSection
                  title="This project"
                  visible={visibleProject}
                  ctx={ctx}
                  places={places}
                  emptyText={emptyText(projectSkills.length, "No skills in this project.")}
                  flat={needle !== ""}
                  selecting={selecting}
                  selected={selected}
                  showFix={onlyAttention}
                  busy={locked}
                  onSelect={setSelection}
                  onPlan={onPlan}
                  onOpen={openSkill}
                />
              )}
              <SkillSection
                title="Global"
                visible={visibleGlobal}
                ctx={ctx}
                places={places}
                emptyText={emptyText(globalSkills.length, "No Global skills yet.")}
                flat={needle !== ""}
                selecting={selecting}
                selected={selected}
                showFix={onlyAttention}
                busy={locked}
                onSelect={setSelection}
                onPlan={onPlan}
                onOpen={openSkill}
              />
              {empty && <p className="text-sm text-muted-foreground">No skills yet.</p>}
              {selecting && chosen.length > 0 && (
                <BulkBar
                  selected={chosen}
                  ctx={ctx}
                  places={places}
                  busy={locked}
                  onPlan={onPlan}
                />
              )}
            </>
          )}
        </>
      )}

      <ConfirmPlan
        plan={confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={() => confirming && void apply(confirming)}
      />
    </div>
  );
}

/** Placeholder rows for a slow load, laid out like the sections they stand in for. */
function SkillsSkeleton({ withProject }: { withProject: boolean }) {
  return (
    <div aria-hidden className="space-y-4">
      {(withProject ? ["This project", "Global"] : ["Global"]).map((title) => (
        <section key={title} className="space-y-2.5">
          <h2 className="flex min-h-7 items-center px-3 text-sm font-normal text-foreground/70 sm:px-4">
            {title}
          </h2>
          <SettingsGroup>
            <ul className="divide-y divide-border/50">
              {[0, 1, 2, 3].map((row) => (
                <li key={row} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                  <span className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-3/4" />
                  </span>
                  <Skeleton shape="pill" className="h-4 w-14" />
                </li>
              ))}
            </ul>
          </SettingsGroup>
        </section>
      ))}
    </div>
  );
}
