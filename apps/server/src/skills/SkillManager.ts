/**
 * SkillManager - turns skills on or off for each agent by making and removing links, or by writing
 * the agent's own settings.
 *
 * A skill has one home, a real folder. An agent reads it either because the agent reads that
 * folder itself (`direct`) or because a link in a folder the agent reads points at it (`link`).
 * Turning a skill on makes such a link in the agent's own folder; turning it off removes it. An
 * agent that reads the folder itself has no link to remove, so where it has a per-skill setting
 * T3 Code knows (see `AgentSkillSettings`) that setting is written instead, and the agent is
 * `off`; otherwise it is `fixed` and stays on. Those writes only touch links this service can show
 * lead to the skill's home: a real folder is never replaced by them. Placing and deleting are the
 * only writes that take a real folder, and only one that sits in an agent's skill folder itself
 * (`own`), never a synced library behind a link (placing a synced skill into some projects links
 * to it instead; see `SkillPlacement`).
 *
 * Every write starts from what the folders hold now, not from what a client last saw: a skill
 * whose home is not where the client said is refused, and each link is checked again right
 * before it is made or removed (see `SkillLinks`). Writes run one request at a time, and an agent
 * whose skills changed has its skill list for the composer refreshed afterwards.
 *
 * @module SkillManager
 */
import {
  SkillRequestError,
  type ProviderInstanceId,
  type SkillBatchResult,
  type SkillDeleteInput,
  type SkillDisableInput,
  type SkillEnableInput,
  type SkillAgentState,
  type SkillOutcome,
  type SkillOutcomeReason,
  type SkillPlaceInput,
  type SkillRef,
  type SkillScope,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import type { SkillSettingsWriter } from "@t3tools/provider-core/server/driver";
import { ownProjectFolderFor } from "@t3tools/provider-core/server/AgentSkillFolders";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { setSkillSwitch, type SkillSwitchWrite, type SwitchedSkill } from "./AgentSkillSettings.ts";
import {
  codexRulesSwitchOff,
  codexSkillFile,
  planCodexSwitch,
  readCodexSkillRules,
} from "./CodexSkillSettings.ts";
import * as SkillCatalog from "./SkillCatalog.ts";
import { createLink, removeLink, type RemoveLinkResult } from "./SkillLinks.ts";
import { deleteFolder } from "./SkillMove.ts";
import { makeSkillPlacement, projectsOfLibrarySkill, type LibrarySkill } from "./SkillPlacement.ts";

type Blocked = SkillOutcome["blocked"][number];

/** What was done to one skill, before it is told to a client. */
interface SkillChange {
  /** A link was made or removed. */
  readonly wrote: boolean;
  /** Agents the change didn't reach. */
  readonly blocked: readonly Blocked[];
  /** Something about the skill as a whole kept the change from being complete. */
  readonly reason?: SkillOutcomeReason | undefined;
  /** Agents that gained or lost the skill without being asked, when the change works that out. */
  readonly affected?: readonly ProviderInstanceId[] | undefined;
  /** Agents whose skill list changed, when the change works that out; their `$` picker is refreshed. */
  readonly touched?: readonly ProviderInstanceId[] | undefined;
  /** The skill's source record couldn't go along with a placement, so it has none now. */
  readonly sourceDropped?: boolean | undefined;
}

/**
 * Links to make so each requested agent that doesn't use the skill yet gets it. An agent gets its
 * link in the shared folder when it reads that, else in its own first folder for the skill's
 * scope; agents that read the same folder share one link. An agent whose own settings switch the
 * skill off (`clears`) gets that setting taken away, unless the skill can't reach it anyway.
 */
export const planEnable = (
  skill: SkillCatalog.ResolvedSkill,
  requested: ReadonlySet<ProviderInstanceId>,
) => {
  const links = new Map<string, { directory: string; agents: ProviderInstanceId[] }>();
  const blocked: Blocked[] = [];
  const clears: ProviderInstanceId[] = [];
  for (const agent of skill.agents) {
    if (!requested.has(agent.instanceId)) continue;
    if (agent.state === "off") {
      clears.push(agent.instanceId);
      continue;
    }
    if (agent.state !== "none") continue;
    const shared = agent.reads.findIndex((read) => read.scope === skill.scope && read.standard);
    const index =
      shared >= 0 ? shared : agent.reads.findIndex((read) => read.scope === skill.scope);
    const root = agent.reads[index];
    if (root === undefined) {
      blocked.push({ instanceId: agent.instanceId, reason: "failed" });
      continue;
    }
    // A link would never load if the agent finds another skill with this name first.
    if (
      agent.collision === "first-wins" &&
      agent.reads.slice(0, index).some((read) => read.rival)
    ) {
      blocked.push({ instanceId: agent.instanceId, reason: "shadowed" });
      continue;
    }
    if (agent.switchedOff) clears.push(agent.instanceId);
    // Linked there already, though the agent doesn't load it (Claude can't read its header).
    if (skill.entries.some((entry) => entry.directory === root.directory)) continue;
    const link = links.get(root.directory);
    if (link) link.agents.push(agent.instanceId);
    else links.set(root.directory, { directory: root.directory, agents: [agent.instanceId] });
  }
  return { links: [...links.values()], blocked, clears };
};

/**
 * Links to remove so each requested agent stops using the skill. An agent that reads the
 * skill's own folder, or a link in the shared folder that serves other agents too, can't be
 * switched by a link: if it has a per-skill setting that is written instead (`switchOffs`),
 * otherwise it stays on. An agent that is off already is left as it is.
 */
const planDisable = (
  skill: SkillCatalog.ResolvedSkill,
  requested: ReadonlySet<ProviderInstanceId>,
) => {
  const unlinks = new Map<string, { path: string; target: string; agents: ProviderInstanceId[] }>();
  const blocked: Blocked[] = [];
  const switchOffs: ProviderInstanceId[] = [];
  for (const agent of skill.agents) {
    if (!requested.has(agent.instanceId) || agent.state === "none" || agent.state === "off") {
      continue;
    }
    const entries = skill.entries.filter((entry) => agent.via.includes(entry.path));
    if (agent.state === "direct" || entries.some((entry) => entry.target === undefined)) {
      if (agent.settings === undefined) {
        blocked.push({ instanceId: agent.instanceId, reason: "alwaysOn" });
      } else {
        switchOffs.push(agent.instanceId);
      }
      continue;
    }
    for (const entry of entries) {
      if (entry.target === undefined) continue;
      const unlink = unlinks.get(entry.path);
      if (unlink) unlink.agents.push(agent.instanceId);
      else
        unlinks.set(entry.path, {
          path: entry.path,
          target: entry.target,
          agents: [agent.instanceId],
        });
    }
  }
  return { unlinks: [...unlinks.values()], blocked, switchOffs };
};

/**
 * What turning agents on takes for a skill used in only some projects. Every project that uses it
 * has a link in the shared folder, which the agents that read that folder already have. An agent
 * that doesn't gets a link in its own folder in each of those projects (`links`), and one whose
 * own settings switch the skill off gets that taken away (`clears`).
 */
const planEnableLibrary = (skill: LibrarySkill, requested: ReadonlySet<ProviderInstanceId>) => {
  const folders = new Map<string, ProviderInstanceId[]>();
  const blocked: Blocked[] = [];
  const clears: ProviderInstanceId[] = [];
  const projects = projectsOfLibrarySkill(skill);
  for (const agent of skill.agents) {
    if (!requested.has(agent.instanceId)) continue;
    if (agent.state === "off") {
      clears.push(agent.instanceId);
      continue;
    }
    if (agent.state !== "none") continue;
    const folder = ownProjectFolderFor(agent.driver);
    // With no project using the skill there is nowhere to link it for the agent.
    if (folder === undefined || projects.length === 0) {
      blocked.push({ instanceId: agent.instanceId, reason: "failed" });
      continue;
    }
    if (agent.switchedOff) clears.push(agent.instanceId);
    folders.set(folder, [...(folders.get(folder) ?? []), agent.instanceId]);
  }
  return {
    links: [...folders].map(([folder, agents]) => ({ folder, agents })),
    blocked,
    clears,
  };
};

/**
 * What turning agents off takes for a skill used in only some projects: the links in an agent's
 * own folder go (`unlinks`), in every project. An agent that reads the shared folder, which every
 * project that uses the skill links into, can't be switched by a link: it has its own setting
 * written (`switchOffs`) or stays on.
 */
const planDisableLibrary = (skill: LibrarySkill, requested: ReadonlySet<ProviderInstanceId>) => {
  const folders = new Map<string, ProviderInstanceId[]>();
  const blocked: Blocked[] = [];
  const switchOffs: ProviderInstanceId[] = [];
  for (const agent of skill.agents) {
    if (!requested.has(agent.instanceId) || agent.state === "none" || agent.state === "off") {
      continue;
    }
    const folder = ownProjectFolderFor(agent.driver);
    if (folder !== undefined) {
      folders.set(folder, [...(folders.get(folder) ?? []), agent.instanceId]);
    } else if (agent.settings === undefined) {
      blocked.push({ instanceId: agent.instanceId, reason: "alwaysOn" });
    } else {
      switchOffs.push(agent.instanceId);
    }
  }
  return {
    unlinks: [...folders].map(([folder, agents]) => ({ folder, agents })),
    blocked,
    switchOffs,
  };
};

const hasSkill = (state: SkillAgentState) => state === "direct" || state === "link";

/**
 * Opens an agent's settings writer the first time a request needs it and keeps it for the rest of
 * the request, so switching a hundred skills in Codex starts Codex once. Undefined when the
 * agent has none or it can't be started.
 */
type SettingsWriters = (
  instanceId: ProviderInstanceId,
) => Effect.Effect<SkillSettingsWriter | undefined>;

const combine = (first: SkillChange, second: SkillChange): SkillChange => ({
  wrote: first.wrote || second.wrote,
  blocked: [...first.blocked, ...second.blocked],
  reason: first.reason ?? second.reason,
});

export class SkillManager extends Context.Service<
  SkillManager,
  {
    /**
     * Make a link in each agent's own folder so it can use each skill. `"all"` means every
     * enabled agent. An agent is named by its instance id, or by its driver kind to mean every
     * instance of that driver when no instance has that id.
     */
    readonly enable: (
      input: Omit<SkillEnableInput, "agents"> & {
        readonly agents: SkillEnableInput["agents"] | "all";
      },
    ) => Effect.Effect<SkillBatchResult, SkillRequestError>;
    /** Remove each agent's link to each skill. Agents are named as for `enable`. */
    readonly disable: (
      input: SkillDisableInput,
    ) => Effect.Effect<SkillBatchResult, SkillRequestError>;
    /** Put each skill where `to` says, moving its folder; the agents that used it keep using it. */
    readonly place: (input: SkillPlaceInput) => Effect.Effect<SkillBatchResult, SkillRequestError>;
    /** Delete each skill's own folder and every link to it. */
    readonly delete: (
      input: SkillDeleteInput,
    ) => Effect.Effect<SkillBatchResult, SkillRequestError>;
  }
>()("t3/skills/SkillManager") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const catalog = yield* SkillCatalog.SkillCatalog;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const writeLock = yield* Semaphore.make(1);
  // The link primitives take the filesystem from their environment.
  const filesystemContext = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | VcsProcess.VcsProcess
  >();

  /**
   * Links are only written under a folder the environment knows as a project. The catalog says
   * which: it refuses any other folder, one that is gone included, before it reads anything.
   */
  const requireProject = (cwd: string) => catalog.resolve({ cwd, skills: [] }).pipe(Effect.asVoid);

  const removeAll = Effect.fnUntraced(function* (
    entries: ReadonlyArray<{ readonly path: string; readonly target: string }>,
  ) {
    const results = new Map<string, RemoveLinkResult | "failed">();
    for (const entry of entries) {
      results.set(
        entry.path,
        yield* removeLink({ path: entry.path, expectedTarget: entry.target }).pipe(
          Effect.provideContext(filesystemContext),
          Effect.catchTags({ SkillLinkError: () => Effect.succeed("failed" as const) }),
        ),
      );
    }
    return results;
  });

  const enableOne = Effect.fnUntraced(function* (
    skill: SkillCatalog.ResolvedSkill,
    requested: ReadonlySet<ProviderInstanceId>,
    projectRoot: string | undefined,
  ) {
    const plan = planEnable(skill, requested);
    const blocked: Blocked[] = [...plan.blocked];
    let wrote = false;
    for (const link of plan.links) {
      const result = yield* createLink({
        link: path.join(link.directory, skill.name),
        home: skill.home,
        scope: skill.scope,
        platform,
        projectRoot,
      }).pipe(
        Effect.provideContext(filesystemContext),
        Effect.catchTags({ SkillLinkError: () => Effect.succeed("failed" as const) }),
      );
      if (result === "created") wrote = true;
      else if (result !== "unchanged") {
        const reason: SkillOutcomeReason =
          result === "taken" ? "entryTaken" : result === "notAllowed" ? "linkNotAllowed" : "failed";
        for (const instanceId of link.agents) blocked.push({ instanceId, reason });
      }
    }
    return { wrote, blocked } satisfies SkillChange;
  });

  const disableOne = Effect.fnUntraced(function* (
    skill: SkillCatalog.ResolvedSkill,
    requested: ReadonlySet<ProviderInstanceId>,
  ) {
    const plan = planDisable(skill, requested);
    const results = yield* removeAll(plan.unlinks);
    const blocked: Blocked[] = [...plan.blocked];
    let wrote = false;
    for (const unlink of plan.unlinks) {
      const result = results.get(unlink.path);
      if (result === "removed") wrote = true;
      else if (result === "changed" || result === "failed") {
        for (const instanceId of unlink.agents) {
          blocked.push({ instanceId, reason: result });
        }
      }
    }
    return { wrote, blocked } satisfies SkillChange;
  });

  /** The writers of one request, each opened on first use inside the request's scope. */
  const makeWriters = (scope: Scope.Scope): SettingsWriters => {
    const opened = new Map<ProviderInstanceId, SkillSettingsWriter | undefined>();
    return (instanceId) =>
      Effect.gen(function* () {
        if (opened.has(instanceId)) return opened.get(instanceId);
        const instance = yield* providerInstances.getInstance(instanceId);
        const writer =
          instance?.enabled && instance.openSkillSettingsWriter
            ? yield* instance.openSkillSettingsWriter.pipe(
                Effect.provideService(Scope.Scope, scope),
                Effect.tapError((error) => Effect.logWarning("skill settings writer", { error })),
                Effect.option,
                Effect.map(Option.getOrUndefined),
              )
            : undefined;
        opened.set(instanceId, writer);
        return writer;
      });
  };

  const switchedSkillOf = (skill: SkillCatalog.ResolvedSkill): SwitchedSkill => ({
    scope: skill.scope,
    name: skill.name,
    declaredName: skill.declaredName,
    home: skill.home,
    entryPaths: skill.entries.map((entry) => entry.path),
  });

  /** Codex's settings are written by Codex; the file is read before and after to check. */
  const switchCodex = Effect.fnUntraced(function* (
    agent: SkillCatalog.ResolvedSkill["agents"][number],
    target: SwitchedSkill,
    off: boolean,
    writers: SettingsWriters,
  ) {
    if (agent.settings === undefined) return "failed" as const;
    const context = agent.settings;
    const file = codexSkillFile(path, target);
    const rules = yield* readCodexSkillRules(context).pipe(
      Effect.provideContext(filesystemContext),
    );
    const changes = planCodexSwitch(rules, file, target, off);
    if (changes.length === 0) return "unchanged" as const;
    const write = yield* writers(agent.instanceId);
    if (write === undefined) return "failed" as const;

    let decidedElsewhere = false;
    for (const change of changes) {
      const result = yield* write(change).pipe(Effect.option);
      if (Option.isNone(result)) return "failed" as const;
      // `effectiveEnabled` is what Codex decides after the write, with every layer it reads.
      if (result.value.effectiveEnabled !== change.enabled) decidedElsewhere = true;
    }
    if (decidedElsewhere) return "setElsewhere" as const;
    const after = yield* readCodexSkillRules(context).pipe(
      Effect.provideContext(filesystemContext),
    );
    return codexRulesSwitchOff(after, file, target) === off
      ? ("written" as const)
      : ("failed" as const);
  });

  /** Writes the agent's own setting for the skill so the agent is `off` (or no longer off). */
  const switchAgents = Effect.fnUntraced(function* (
    skill: SkillCatalog.ResolvedSkill,
    instanceIds: readonly ProviderInstanceId[],
    off: boolean,
    writers: SettingsWriters,
  ) {
    const target = switchedSkillOf(skill);
    const blocked: Blocked[] = [];
    let wrote = false;
    for (const instanceId of instanceIds) {
      const agent = skill.agents.find((candidate) => candidate.instanceId === instanceId);
      if (agent === undefined) continue;
      const result: SkillSwitchWrite =
        agent.settings === undefined
          ? "failed"
          : agent.driver === "codex"
            ? yield* switchCodex(agent, target, off, writers)
            : yield* setSkillSwitch(agent.settings, target, off).pipe(
                Effect.provideContext(filesystemContext),
              );
      if (result === "written") wrote = true;
      else if (result === "setElsewhere" || result === "failed") {
        blocked.push({ instanceId, reason: result });
      }
    }
    return { wrote, blocked } satisfies SkillChange;
  });

  const placement = yield* makeSkillPlacement({
    catalog,
    platform,
    environment,
    home: homeDirectory,
    registeredRoots: projects.listShells().pipe(
      Effect.map((shells) => shells.map((shell) => shell.workspaceRoot)),
      Effect.orElseSucceed((): string[] => []),
    ),
    enable: (skill, agents, projectRoot) => enableOne(skill, agents, projectRoot),
  });

  /** A skill used in only some projects: links in the projects' folders, and the agents' settings. */
  const enableLibraryAgents = Effect.fnUntraced(function* (
    skill: LibrarySkill,
    requested: ReadonlySet<ProviderInstanceId>,
    writers: SettingsWriters,
  ) {
    const plan = planEnableLibrary(skill, requested);
    const linked = yield* placement.addLibraryLinks(skill, plan.links);
    const cleared = yield* switchAgents(skill, plan.clears, false, writers);
    return {
      wrote: linked.wrote || cleared.wrote,
      blocked: [...plan.blocked, ...linked.blocked, ...cleared.blocked],
    } satisfies SkillChange;
  });

  const disableLibraryAgents = Effect.fnUntraced(function* (
    skill: LibrarySkill,
    requested: ReadonlySet<ProviderInstanceId>,
    writers: SettingsWriters,
  ) {
    const plan = planDisableLibrary(skill, requested);
    const unlinked = yield* placement.removeLibraryLinks(skill, plan.unlinks);
    const switched = yield* switchAgents(skill, plan.switchOffs, true, writers);
    return {
      wrote: unlinked.wrote || switched.wrote,
      blocked: [...plan.blocked, ...unlinked.blocked, ...switched.blocked],
    } satisfies SkillChange;
  });

  const enableAgents = Effect.fnUntraced(function* (
    skill: SkillCatalog.ResolvedSkill,
    requested: ReadonlySet<ProviderInstanceId>,
    projectRoot: string | undefined,
    writers: SettingsWriters,
  ) {
    if (skill.library !== undefined) {
      return yield* enableLibraryAgents({ ...skill, library: skill.library }, requested, writers);
    }
    const linked = yield* enableOne(skill, requested, projectRoot);
    const cleared = yield* switchAgents(skill, planEnable(skill, requested).clears, false, writers);
    return combine(linked, cleared);
  });

  const disableAgents = Effect.fnUntraced(function* (
    skill: SkillCatalog.ResolvedSkill,
    requested: ReadonlySet<ProviderInstanceId>,
    writers: SettingsWriters,
  ) {
    if (skill.library !== undefined) {
      return yield* disableLibraryAgents({ ...skill, library: skill.library }, requested, writers);
    }
    const unlinked = yield* disableOne(skill, requested);
    const switched = yield* switchAgents(
      skill,
      planDisable(skill, requested).switchOffs,
      true,
      writers,
    );
    return combine(unlinked, switched);
  });

  /**
   * Codex names a skill it switches off by the real path of its SKILL.md, so a moved folder leaves
   * that entry behind and the skill on. The setting goes to the new path and the old entry is
   * cleared, through Codex like any other write. A rule that names the skill by its name needs no
   * change. The agents it couldn't carry over are returned.
   */
  const followCodexMove = Effect.fnUntraced(function* (
    skill: SkillCatalog.ResolvedSkill,
    home: string,
    writers: SettingsWriters,
  ) {
    const blocked: Blocked[] = [];
    const old = switchedSkillOf(skill);
    const from = codexSkillFile(path, old);
    const moved: SwitchedSkill = { ...old, home, entryPaths: [] };
    for (const agent of skill.agents) {
      if (agent.driver !== "codex" || agent.settings === undefined) continue;
      const rules = yield* readCodexSkillRules(agent.settings).pipe(
        Effect.provideContext(filesystemContext),
      );
      const keyed = rules.findLast(
        (rule) => "path" in rule.selector && rule.selector.path === from,
      );
      if (keyed === undefined || keyed.enabled) continue;
      const wrote = yield* switchCodex(agent, moved, true, writers);
      if (wrote === "failed" || wrote === "setElsewhere") {
        blocked.push({ instanceId: agent.instanceId, reason: wrote });
        continue;
      }
      const write = yield* writers(agent.instanceId);
      const cleared =
        write === undefined
          ? undefined
          : yield* write({ path: from, enabled: true }).pipe(Effect.option);
      if (cleared === undefined || Option.isNone(cleared)) {
        blocked.push({ instanceId: agent.instanceId, reason: "failed" });
      }
    }
    return blocked;
  });

  /** The links among the skills' entries, with what each points at as written. */
  const linksTo = (skills: ReadonlyArray<SkillCatalog.ResolvedSkill>) =>
    skills.flatMap((skill) =>
      skill.entries.flatMap((entry) =>
        entry.target === undefined ? [] : [{ path: entry.path, target: entry.target }],
      ),
    );

  const skipped = (reason: SkillOutcomeReason): SkillChange => ({
    wrote: false,
    blocked: [],
    reason,
  });

  /** Every group that reaches this skill's folder, in either scope: the folder's whole audience. */
  const reaching = (
    skill: SkillCatalog.ResolvedSkill,
    all: ReadonlyArray<SkillCatalog.ResolvedSkill>,
  ) => all.filter((other) => other.name === skill.name && other.home === skill.home);

  const agentsWith = (skills: ReadonlyArray<SkillCatalog.ResolvedSkill>) =>
    new Set(
      skills.flatMap((skill) =>
        skill.agents.filter((agent) => hasSkill(agent.state)).map((agent) => agent.instanceId),
      ),
    );

  const deleteOne = Effect.fnUntraced(function* (
    skill: SkillCatalog.ResolvedSkill,
    all: ReadonlyArray<SkillCatalog.ResolvedSkill>,
  ) {
    if (!skill.own) return skipped("linked");
    const audience = reaching(skill, all);
    const had = [...agentsWith(audience)];
    const failed = yield* deleteFolder(skill.home).pipe(
      Effect.provideContext(filesystemContext),
      Effect.as(false),
      Effect.catchTags({ SkillMoveError: () => Effect.succeed(true) }),
    );
    // A delete that stopped before touching SKILL.md changed nothing an agent can see.
    if (
      failed &&
      (yield* fileSystem
        .exists(path.join(skill.home, "SKILL.md"))
        .pipe(Effect.orElseSucceed(() => true)))
    ) {
      return skipped("failed");
    }
    // A library skill is linked into projects the list may not have been read for.
    yield* placement.unlinkLibrarySkill(skill);
    const results = new Set((yield* removeAll(linksTo(audience))).values());
    const reason: SkillOutcomeReason | undefined =
      failed || results.has("failed") ? "failed" : results.has("changed") ? "changed" : undefined;
    return {
      wrote: true,
      blocked: [],
      reason,
      affected: had,
      touched: had,
    } satisfies SkillChange;
  });

  /**
   * Refreshes the skills the composer's `$` picker lists for agents whose skills changed: the
   * project's own list when a project is open, else the agent's machine-wide one. A scan can take
   * seconds, since some agents answer through their CLI, and the change is already on disk, so it
   * runs in the background and a scan that fails changes nothing.
   */
  const refreshPickers = (cwd: string | undefined, instances: Iterable<ProviderInstanceId>) =>
    Effect.forEach(
      instances,
      (instanceId) =>
        cwd === undefined
          ? providers.refreshInstance(instanceId)
          : providers.refreshWorkspaceSnapshot({ instanceId, cwd, fresh: true }),
      { discard: true },
    ).pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  /**
   * Looks every skill up as the folders hold it now, applies `change` to those that are still
   * where the client said, and tells what happened to each. An agent that gained or lost a skill
   * without being asked is found by reading the folders again afterwards.
   */
  const run = (input: {
    readonly cwd: string | undefined;
    readonly skills: ReadonlyArray<SkillRef>;
    readonly agents: "all" | ReadonlySet<string>;
    /** Skills to look up besides those asked for, such as the same names in the other scope. */
    readonly alsoLookUp?: ReadonlyArray<{ readonly scope: SkillScope; readonly name: string }>;
    readonly change: (
      skill: SkillCatalog.ResolvedSkill,
      agents: ReadonlySet<ProviderInstanceId>,
      projectRoot: string | undefined,
      /** Everything looked up, which includes the skills asked for. */
      all: ReadonlyArray<SkillCatalog.ResolvedSkill>,
    ) => Effect.Effect<SkillChange>;
  }) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const before = yield* catalog.resolve({
          cwd: input.cwd,
          skills: [...input.skills, ...(input.alsoLookUp ?? [])],
        });
        const instances = before[0]?.agents ?? [];
        const agents = new Set<ProviderInstanceId>();
        for (const name of input.agents === "all" ? [] : input.agents) {
          const byId = instances.filter((agent) => agent.instanceId === name);
          const matches =
            byId.length > 0 ? byId : instances.filter((agent) => agent.driver === name);
          if (matches.length === 0 && instances.length > 0) {
            return yield* new SkillRequestError({ reason: "unknownAgent" });
          }
          for (const agent of matches) agents.add(agent.instanceId);
        }
        if (input.agents === "all") for (const agent of instances) agents.add(agent.instanceId);
        const projectRoot =
          input.cwd === undefined
            ? undefined
            : yield* fileSystem.realPath(input.cwd).pipe(Effect.orElseSucceed(() => input.cwd));

        const changes = yield* Effect.forEach(input.skills, (ref) =>
          Effect.gen(function* () {
            const candidates = before.filter(
              (skill) => skill.scope === ref.scope && skill.name === ref.name,
            );
            const found = candidates.find((skill) => skill.displayHome === ref.home);
            if (found === undefined) {
              const reason = candidates.length > 0 ? "changed" : "notFound";
              return { ref, found, change: { wrote: false, blocked: [], reason } as SkillChange };
            }
            return { ref, found, change: yield* input.change(found, agents, projectRoot, before) };
          }),
        );

        const after = changes.some((entry) => entry.change.wrote)
          ? yield* catalog.resolve({ cwd: input.cwd, skills: input.skills })
          : before;
        const results = changes.map(({ ref, found, change }) => {
          const now = after.find(
            (skill) =>
              skill.scope === ref.scope &&
              skill.name === ref.name &&
              skill.displayHome === ref.home,
          );
          // Agents whose use of the skill flipped, whether they were asked for or not.
          const flipped =
            found === undefined
              ? []
              : found.agents
                  .filter(
                    (agent) =>
                      hasSkill(agent.state) !==
                      hasSkill(
                        now?.agents.find((other) => other.instanceId === agent.instanceId)?.state ??
                          "none",
                      ),
                  )
                  .map((agent) => agent.instanceId);
          return {
            // Only what this request wrote counts; a change someone else made meanwhile doesn't.
            touched: change.wrote ? (change.touched ?? flipped) : [],
            outcome: {
              skill: ref,
              status: change.wrote
                ? "changed"
                : change.reason !== undefined || change.blocked.length > 0
                  ? "skipped"
                  : "unchanged",
              ...(change.reason === undefined ? {} : { reason: change.reason }),
              ...(change.sourceDropped === true ? { sourceDropped: true } : {}),
              blocked: change.blocked.filter(
                (item, index, all) =>
                  all.findIndex((other) => other.instanceId === item.instanceId) === index,
              ),
              affected: change.affected ?? flipped.filter((id) => !agents.has(id)),
            } satisfies SkillOutcome,
          };
        });

        const touched = new Set(results.flatMap((result) => result.touched));
        if (touched.size > 0) yield* refreshPickers(input.cwd, touched);
        return { outcomes: results.map((result) => result.outcome) } satisfies SkillBatchResult;
      }),
    );

  return SkillManager.of({
    enable: Effect.fn("SkillManager.enable")(function* (input) {
      // Codex, if it has to be asked, stays open for the whole request.
      const writers = makeWriters(yield* Scope.Scope);
      return yield* run({
        cwd: input.cwd,
        skills: input.skills,
        agents: input.agents === "all" ? "all" : new Set(input.agents),
        change: (skill, agents, projectRoot) => enableAgents(skill, agents, projectRoot, writers),
      });
    }, Effect.scoped),
    disable: Effect.fn("SkillManager.disable")(function* (input) {
      const writers = makeWriters(yield* Scope.Scope);
      return yield* run({
        cwd: input.cwd,
        skills: input.skills,
        agents: new Set(input.agents),
        change: (skill, agents) => disableAgents(skill, agents, writers),
      });
    }, Effect.scoped),
    place: Effect.fn("SkillManager.place")(function* (input) {
      // Codex, if its setting has to follow a moved folder, stays open for the whole request.
      const writers = makeWriters(yield* Scope.Scope);
      const { to } = input;
      // The skills' own folder is checked when they are looked up.
      if (to.kind === "project") yield* requireProject(to.cwd);
      if (to.kind === "projects") for (const cwd of to.cwds) yield* requireProject(cwd);
      return yield* run({
        cwd: input.cwd,
        skills: input.skills,
        agents: new Set(),
        // The same names in the other scope are in the way of a move, or are what links lead to.
        alsoLookUp: input.skills.flatMap((ref) => [
          { scope: "global" as const, name: ref.name },
          { scope: "project" as const, name: ref.name },
        ]),
        change: (skill, _agents, _projectRoot, all) =>
          placement.place(skill, to, {
            cwd: input.cwd,
            all,
            followMove: (home) => followCodexMove(skill, home, writers),
          }),
      });
    }, Effect.scoped),
    delete: Effect.fn("SkillManager.delete")(function* (input) {
      return yield* run({
        cwd: input.cwd,
        skills: input.skills,
        agents: new Set(),
        // Links from the other scope lead to the folder too, and would be left dangling.
        alsoLookUp: input.skills.map((ref) => ({
          scope: ref.scope === "project" ? ("global" as const) : ("project" as const),
          name: ref.name,
        })),
        change: (skill, _agents, _projectRoot, all) => deleteOne(skill, all),
      });
    }),
  });
});

export const layer = Layer.effect(SkillManager, make);
