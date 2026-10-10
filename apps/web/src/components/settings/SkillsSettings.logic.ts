import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  SkillAgentAccess,
  SkillListResult,
  SkillOutcome,
  SkillOutcomeReason,
  SkillPlacement,
  SkillRef,
  SkillScope,
  SkillSummary,
} from "@t3tools/contracts";

import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";

/** An enabled provider instance, named and drawn the way the rest of the app does. */
export type SkillAgent = Pick<
  ProviderInstanceEntry,
  "instanceId" | "driverKind" | "displayName" | "accentColor"
>;

const joinNames = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export type Skill = SkillSummary & {
  /** Stable across reads, so an open skill survives a refresh. */
  readonly id: string;
};

export type SkillsContext = {
  /** Provider instances that are installed, enabled and known to the server's folder table. */
  readonly installed: readonly SkillAgent[];
};

/**
 * The environment the page reads skills from. The settings scope names it, connected or not: an
 * offline environment is reported as offline, never swapped for another one, whose skills would
 * be shown as the project's and which would be sent the project's folder. Only a scope that names
 * no environment falls back to the primary one, then the first.
 */
export function skillsEnvironment<T extends { readonly environmentId: EnvironmentId }>(input: {
  /** The scope's connected environment, when it has one. */
  readonly connected: T | null;
  readonly scopeEnvironmentIds: readonly EnvironmentId[];
  readonly environments: readonly T[];
  readonly primaryId: EnvironmentId | null;
}): T | undefined {
  if (input.connected) return input.connected;
  if (input.scopeEnvironmentIds.length > 0) {
    return input.environments.find((item) =>
      input.scopeEnvironmentIds.includes(item.environmentId),
    );
  }
  return (
    input.environments.find((item) => item.environmentId === input.primaryId) ??
    input.environments[0]
  );
}

export function ingestSkills(result: SkillListResult) {
  const skills = result.skills.map((entry): Skill => ({
    ...entry,
    id: `${entry.scope}\0${entry.name}\0${entry.home}`,
  }));
  const known = new Set(skills.flatMap((skill) => skill.access.map((access) => access.instanceId)));
  return { skills, unreadable: result.unreadable, known };
}

export function installedAgents(
  providers: readonly ServerProvider[],
  known: ReadonlySet<ProviderInstanceId>,
): SkillAgent[] {
  return deriveProviderInstanceEntries(providers)
    .filter(
      (entry) =>
        known.has(entry.instanceId) && entry.installed && entry.enabled && entry.isAvailable,
    )
    .map(({ instanceId, driverKind, displayName, accentColor }) => ({
      instanceId,
      driverKind,
      displayName,
      accentColor,
    }));
}

// -- Access -----------------------------------------------------------------------------------

const accessOf = (
  skill: Skill,
  agent: Pick<SkillAgent, "instanceId">,
): SkillAgentAccess | undefined =>
  skill.access.find((access) => access.instanceId === agent.instanceId);

/** The agent loads the skill: through a link, or by reading its folder. */
export const hasAccess = (skill: Skill, agent: SkillAgent) => {
  const state = accessOf(skill, agent)?.state;
  return state === "direct" || state === "link";
};

/** Installed agents that don't load this copy of the skill. */
const missingAgents = (skill: Skill, ctx: SkillsContext) =>
  ctx.installed.filter((agent) => !hasAccess(skill, agent));

// -- Attention --------------------------------------------------------------------------------

type Attention = {
  /** A conflict gets a badge on its row; the others only show in the list filter and the skill. */
  kind: "conflict" | "header" | "missing";
  detail: string;
};

const scopeName = (scope: SkillScope) => (scope === "global" ? "Global" : "This project");

/** One plain sentence on what is wrong, or null for a healthy skill. */
export function attention(skill: Skill, ctx: SkillsContext): Attention | null {
  const other = skill.copies.find((copy) => !copy.same);
  if (other) {
    const detail =
      other.scope !== skill.scope
        ? `${scopeName(other.scope)} has a different “${skill.name}”.`
        : skill.scope === "global"
          ? `Another global “${skill.name}” is different.`
          : `Another “${skill.name}” in this project is different.`;
    return { kind: "conflict", detail };
  }
  const claude = ctx.installed.filter((agent) => agent.driverKind === "claudeAgent");
  if (skill.invalidHeader && claude.length > 0) {
    return {
      kind: "header",
      detail: `${joinNames(claude.map((agent) => agent.displayName))} can't read this skill's header.`,
    };
  }
  const missing = missingAgents(skill, ctx);
  return missing.length === 0
    ? null
    : {
        kind: "missing",
        detail: `Not available to ${joinNames(missing.map((agent) => agent.displayName))}`,
      };
}

/** Who can use a skill, among the installed agents. */
export type Availability = {
  /** Every installed agent can use it. */
  everyone: boolean;
  agents: SkillAgent[];
  /** Installed agents that can't. */
  missing: SkillAgent[];
};

export function availability(skill: Skill, ctx: SkillsContext): Availability {
  const missing = missingAgents(skill, ctx);
  return {
    everyone: ctx.installed.length > 0 && missing.length === 0,
    agents: ctx.installed.filter((agent) => hasAccess(skill, agent)),
    missing,
  };
}

/** The tooltip on a row's agent icons. */
export const availabilityNote = (value: Availability) =>
  value.everyone
    ? "Available to all your agents"
    : `Not available to ${joinNames(value.missing.map((agent) => agent.displayName))}`;

/** One short line on the folders the server couldn't read, which would otherwise look empty. */
export function unreadableNote(folders: SkillListResult["unreadable"]) {
  const [first, second, ...rest] = folders.map((item) => item.folder);
  if (first === undefined) return "";
  if (second === undefined) return `Couldn't read ${first}`;
  return rest.length === 0
    ? `Couldn't read ${first} and ${second}`
    : `Couldn't read ${first}, ${second} and ${rest.length} more`;
}

// -- Turning skills on and off ------------------------------------------------------------------

/** What to ask the server for. */
export type SkillChange =
  | {
      readonly kind: "enable" | "disable";
      readonly skills: readonly SkillRef[];
      readonly agents: readonly ProviderInstanceId[];
    }
  | {
      readonly kind: "place";
      readonly skills: readonly SkillRef[];
      readonly to: SkillPlacement;
      /** The projects `to` names, for telling the person where the skills went. */
      readonly projectNames: readonly string[];
      /** Where each skill came from (`owner/repo`), by `Skill.id`, for telling one that lost it. */
      readonly sources?: Readonly<Record<string, string>>;
    }
  | { readonly kind: "delete"; readonly skills: readonly SkillRef[] };

export type SkillPlan = {
  readonly change: SkillChange;
  /** How many skills it changes. */
  readonly affected: number;
  /** Present when the change should be confirmed first, in plain words. */
  readonly confirmation?: {
    readonly title: string;
    /** May be empty when the title says it all. */
    readonly body: string;
    /** Lines under the body, such as what stays on and why. */
    readonly notes: readonly string[];
    readonly confirm: string;
    readonly destructive: boolean;
  };
};

const skillRef = (skill: Skill): SkillRef => ({
  scope: skill.scope,
  name: skill.name,
  home: skill.home,
});

const enablePlan = (skills: readonly Skill[], agents: readonly SkillAgent[]): SkillPlan => ({
  change: {
    kind: "enable",
    skills: skills.map(skillRef),
    agents: agents.map((agent) => agent.instanceId),
  },
  affected: skills.length,
});

/** T3 Code can't switch this agent for this skill: it reads the folder and has no setting for it. */
const isFixed = (skill: Skill, agent: Pick<SkillAgent, "instanceId">) =>
  accessOf(skill, agent)?.fixed === true;

/** Installed agents T3 Code can switch for this skill. */
const switchableAgents = (skill: Skill, ctx: SkillsContext) =>
  ctx.installed.filter((agent) => !isFixed(skill, agent));

/** Why an agent's switch can't be flipped, or null when it can. */
export function switchBlocker(skill: Skill, agent: SkillAgent) {
  if (!isFixed(skill, agent)) return null;
  return hasAccess(skill, agent)
    ? `Always on. ${agent.displayName} reads this folder directly.`
    : `${agent.displayName} can't be switched for this skill.`;
}

/** One skill's switch is on when any agent uses it; the icons show who. */
export const rowSwitchOn = (skill: Skill, ctx: SkillsContext) =>
  ctx.installed.some((agent) => hasAccess(skill, agent));

/** A section's or group's switch is on when every row switch in it is on. */
export const listSwitchOn = (skills: readonly Skill[], ctx: SkillsContext) =>
  skills.length > 0 && skills.every((skill) => rowSwitchOn(skill, ctx));

/** Turning one agent on for one skill, or off. Off asks first when other agents lose it too. */
export function planToggle(skill: Skill, agent: SkillAgent, ctx: SkillsContext) {
  return hasAccess(skill, agent) ? planTurnOff([skill], agent, ctx) : enablePlan([skill], [agent]);
}

/** Every agent that lacks one of the skills, and can be switched, gets it; nothing asks first. */
export function planTurnOnAll(selected: readonly Skill[], ctx: SkillsContext): SkillPlan | null {
  const wanted = selected
    .map((skill) => ({
      skill,
      missing: switchableAgents(skill, ctx).filter((agent) => !hasAccess(skill, agent)),
    }))
    .filter((entry) => entry.missing.length > 0);
  if (wanted.length === 0) return null;
  const ids = new Set(wanted.flatMap((entry) => entry.missing.map((agent) => agent.instanceId)));
  return enablePlan(
    wanted.map((entry) => entry.skill),
    ctx.installed.filter((agent) => ids.has(agent.instanceId)),
  );
}

const staysOnNote = (count: number, agent: SkillAgent) =>
  `${plural(count, "skill")} ${count === 1 ? "stays" : "stay"} on because ${agent.displayName} reads ${count === 1 ? "its" : "their"} folder.`;

/**
 * Every agent that uses one of the skills is switched off. Agents T3 Code can't switch are asked
 * anyway, so the result can say why a skill stays on. With `ask`, the change waits for a yes.
 */
export function planTurnOffAll(
  selected: readonly Skill[],
  ctx: SkillsContext,
  { ask }: { ask: boolean },
): SkillPlan | null {
  const targets = selected.filter((skill) => rowSwitchOn(skill, ctx));
  if (targets.length === 0) return null;
  const agents = ctx.installed.filter((agent) => targets.some((skill) => hasAccess(skill, agent)));
  const notes = agents.flatMap((agent) => {
    const stays = targets.filter((skill) => isFixed(skill, agent) && hasAccess(skill, agent));
    return stays.length > 0 ? [staysOnNote(stays.length, agent)] : [];
  });
  return {
    change: {
      kind: "disable",
      skills: targets.map(skillRef),
      agents: agents.map((agent) => agent.instanceId),
    },
    affected: targets.length,
    ...(ask
      ? {
          confirmation: {
            title: `Turn off ${targets.length === 1 ? `“${targets[0]!.name}”` : plural(targets.length, "skill")} for every agent?`,
            body: "",
            notes,
            confirm: "Turn off",
            destructive: false,
          },
        }
      : {}),
  };
}

/** What a row's switch does: turn the skill on for every agent, or off for every agent. */
export const planRowSwitch = (skill: Skill, ctx: SkillsContext) =>
  rowSwitchOn(skill, ctx)
    ? planTurnOffAll([skill], ctx, { ask: false })
    : planTurnOnAll([skill], ctx);

/**
 * What a section's or group's switch does. On turns every skill on for every agent, filling in
 * agents that were off on rows already on; off asks first.
 */
export const planListSwitch = (skills: readonly Skill[], ctx: SkillsContext) =>
  listSwitchOn(skills, ctx)
    ? planTurnOffAll(skills, ctx, { ask: true })
    : planTurnOnAll(skills, ctx);

/** Other installed agents that lose the skill when this agent's link goes: same folder, same link. */
function alsoLosesOnTurnOff(skill: Skill, agent: SkillAgent, ctx: SkillsContext) {
  const target = accessOf(skill, agent);
  if (target?.state !== "link") return [];
  return ctx.installed.filter((other) => {
    const access = accessOf(skill, other);
    return (
      other.instanceId !== agent.instanceId &&
      access?.state === "link" &&
      access.folder === target.folder
    );
  });
}

/** Turning one agent off for the skills it uses. Others stay on. */
export function planTurnOff(
  selected: readonly Skill[],
  agent: SkillAgent,
  ctx: SkillsContext,
): SkillPlan | null {
  const using = selected.filter((skill) => hasAccess(skill, agent));
  const targets = using.filter((skill) => !isFixed(skill, agent));
  const stuck = using.filter((skill) => isFixed(skill, agent));
  if (using.length === 0) return null;
  const alsoLose = new Map(
    targets
      .flatMap((skill) => alsoLosesOnTurnOff(skill, agent, ctx))
      .map((other) => [other.instanceId, other] as const),
  );
  const notes: string[] = [];
  if (alsoLose.size > 0) {
    notes.push(
      `${joinNames([...alsoLose.values()].map((other) => other.displayName))} ${alsoLose.size === 1 ? "loses" : "lose"} ${targets.length === 1 ? "it" : "these"} too.`,
    );
  }
  if (stuck.length > 0) notes.push(staysOnNote(stuck.length, agent));
  return {
    change: {
      kind: "disable",
      skills: targets.map(skillRef),
      agents: [agent.instanceId],
    },
    affected: targets.length,
    ...(notes.length > 0 && targets.length > 0
      ? {
          confirmation: {
            title: `Turn off for ${agent.displayName}?`,
            body: `Removes ${agent.displayName}'s link for ${plural(targets.length, "skill")}.`,
            notes,
            confirm: "Turn off",
            destructive: false,
          },
        }
      : {}),
  };
}

// -- Selecting and grouping -------------------------------------------------------------------

/** A checkbox over several rows: ticked when all are, indeterminate when only some are. */
export function checkState(ids: readonly string[], selected: ReadonlySet<string>) {
  const count = ids.filter((id) => selected.has(id)).length;
  return {
    checked: ids.length > 0 && count === ids.length,
    indeterminate: count > 0 && count < ids.length,
  };
}

/** A group shows this many skills before a "more" row. */
export const GROUP_PREVIEW = 3;

export type SkillGroup = { readonly source: string; readonly skills: readonly Skill[] };

/**
 * Skills the installer says came from the same place form a group when there are two or more.
 * Groups come first, by name; everything else keeps its order.
 */
export function groupBySource(skills: readonly Skill[]): {
  groups: SkillGroup[];
  loose: Skill[];
} {
  const bySource = new Map<string, Skill[]>();
  for (const skill of skills) {
    if (!skill.source) continue;
    const list = bySource.get(skill.source);
    if (list) list.push(skill);
    else bySource.set(skill.source, [skill]);
  }
  const groups = [...bySource]
    .filter(([, list]) => list.length >= 2)
    .map(([source, list]): SkillGroup => ({ source, skills: list }))
    .toSorted((a, b) => a.source.localeCompare(b.source));
  const grouped = new Set(groups.map((group) => group.source));
  return { groups, loose: skills.filter((skill) => !skill.source || !grouped.has(skill.source)) };
}

/** Who has all of a group's skills on, in the same terms as one skill's icons. */
export function groupAvailability(skills: readonly Skill[], ctx: SkillsContext): Availability {
  const agents = ctx.installed.filter((agent) => skills.every((skill) => hasAccess(skill, agent)));
  const missing = ctx.installed.filter((agent) => !agents.includes(agent));
  return { everyone: ctx.installed.length > 0 && missing.length === 0, agents, missing };
}

/** The badge on a Global skill that is used in some projects only. */
export const projectsBadge = (skill: Skill) =>
  skill.projects && skill.projects.length > 0 ? plural(skill.projects.length, "project") : null;

// -- Placing and deleting ---------------------------------------------------------------------

/** A registered project of this environment, as the Use in… list shows it. */
export type ProjectOption = { readonly cwd: string; readonly label: string };

/** Where "Use in…" can put skills. */
export type PlaceChoice = "project" | "global" | "projects";

export type PlaceTarget =
  | { readonly kind: "project"; readonly project: ProjectOption }
  | { readonly kind: "global" }
  | { readonly kind: "projects"; readonly projects: readonly ProjectOption[] };

/** The server takes at most this many projects in one placement. */
const MAX_PLACE_PROJECTS = 64;

const placementOf = (skill: Skill): PlaceChoice =>
  skill.scope === "project" ? "project" : skill.projects?.length ? "projects" : "global";

/**
 * What the Use in… list starts on: where the skills are now, when they all share one place, and
 * the projects ticked: the ones a skill is used in, else the project picked above the page.
 */
export function startingPlacement(selected: readonly Skill[], picked: ProjectOption | null) {
  const places = new Set(selected.map(placementOf));
  const choice = places.size === 1 ? [...places][0]! : null;
  const used = [...new Set(selected.flatMap((skill) => skill.projects ?? []))];
  const ticked = choice === "projects" ? used : picked ? [picked.cwd] : [];
  return { choice, ticked };
}

/** The placement a choice stands for, or null while it is unfinished or can't be asked for. */
export function placeTarget(
  choice: PlaceChoice | null,
  picked: ProjectOption | null,
  projects: readonly ProjectOption[],
  ticked: ReadonlySet<string>,
): PlaceTarget | null {
  switch (choice) {
    case "project":
      return picked ? { kind: "project", project: picked } : null;
    case "global":
      return { kind: "global" };
    case "projects": {
      const chosen = projects.filter((project) => ticked.has(project.cwd));
      return chosen.length > 0 && chosen.length <= MAX_PLACE_PROJECTS
        ? { kind: "projects", projects: chosen }
        : null;
    }
    default:
      return null;
  }
}

/** Whether the skill is placed that way already, so there is nothing to do for it. */
function placedAlready(skill: Skill, target: PlaceTarget) {
  switch (target.kind) {
    case "project":
      return skill.scope === "project";
    case "global":
      return skill.scope === "global" && !skill.projects?.length;
    case "projects": {
      const used = new Set(skill.projects ?? []);
      return (
        skill.scope === "global" &&
        used.size === target.projects.length &&
        target.projects.every((project) => used.has(project.cwd))
      );
    }
  }
}

const placement = (target: PlaceTarget): SkillPlacement =>
  target.kind === "project"
    ? { kind: "project", cwd: target.project.cwd }
    : target.kind === "global"
      ? { kind: "global" }
      : { kind: "projects", cwds: target.projects.map((project) => project.cwd) };

const projectNamesOf = (target: PlaceTarget) =>
  target.kind === "project"
    ? [target.project.label]
    : target.kind === "projects"
      ? target.projects.map((project) => project.label)
      : [];

/**
 * Putting skills in one project, in every project, or in some. It always asks first, since it
 * changes who sees the skills. Skills that are placed that way already are left out.
 */
export function planPlace(selected: readonly Skill[], target: PlaceTarget): SkillPlan | null {
  const coming = selected.filter((skill) => !placedAlready(skill, target));
  if (coming.length === 0) return null;
  const what = coming.length === 1 ? coming[0]!.name : plural(coming.length, "skill");
  const alreadyGlobal = coming.every((skill) => skill.scope === "global");
  const names = projectNamesOf(target);
  const where = joinNames(names);
  const sources = coming.flatMap((skill) =>
    skill.source ? [[skill.id, skill.source] as const] : [],
  );
  const confirmation = (() => {
    switch (target.kind) {
      case "project":
        return {
          title: `Use ${what} only in ${where}?`,
          body: `It moves into ${where}, so anyone who clones it gets it.`,
          confirm: "Move",
        };
      case "global":
        return {
          title: alreadyGlobal ? `Use ${what} in every project?` : `Make ${what} Global?`,
          body: "It will be on in every project.",
          confirm: alreadyGlobal ? "Apply" : "Make Global",
        };
      case "projects":
        return {
          title: alreadyGlobal ? `Use ${what} only in ${where}?` : `Make ${what} Global?`,
          body:
            names.length === 1
              ? `It will be on in ${where} only.`
              : `It will be on in ${where}. There's one copy, so an edit shows up in ${names.length === 2 ? "both" : "all of them"}.`,
          confirm: alreadyGlobal ? "Apply" : "Make Global",
        };
    }
  })();
  return {
    change: {
      kind: "place",
      skills: coming.map(skillRef),
      to: placement(target),
      projectNames: names,
      ...(sources.length > 0 ? { sources: Object.fromEntries(sources) } : {}),
    },
    affected: coming.length,
    confirmation: { ...confirmation, notes: [], destructive: false },
  };
}

/** Whether the skill's own folder is in an agent's skill folder, which is what can be deleted. */
const hasOwnFolder = (skill: Skill) => skill.realFolder === true;

const quoted = (skills: readonly Skill[]) => skills.map((skill) => `“${skill.name}”`);

/** The skill names a note lists, cut short so a long selection stays one line. */
const someNames = (skills: readonly Skill[], shown = 4) =>
  skills.length <= shown
    ? joinNames(quoted(skills))
    : `${quoted(skills.slice(0, shown)).join(", ")} and ${skills.length - shown} more`;

/** Skills that stay because they are reached through a link, not kept in an agent's folder. */
const linkedNote = (kept: readonly Skill[]) =>
  kept.length === 0
    ? []
    : [
        `${plural(kept.length, "skill")} ${kept.length === 1 ? "is" : "are"} reached through a link, so ${kept.length === 1 ? "it stays" : "they stay"}.`,
      ];

/**
 * Deleting the skills' own folders and the links that lead to them. A skill that is only linked
 * here, such as one from a synced library, can't be deleted from this page at all.
 */
export function planDelete(selected: readonly Skill[], ctx: SkillsContext): SkillPlan | null {
  const targets = selected.filter(hasOwnFolder);
  if (targets.length === 0) return null;
  const kept = selected.filter((skill) => !hasOwnFolder(skill));
  const notes: string[] = [];
  if (targets.length === 1) {
    const losing = ctx.installed.filter((agent) => hasAccess(targets[0]!, agent));
    if (losing.length > 0) {
      notes.push(`${joinNames(losing.map((agent) => agent.displayName))} will stop using it.`);
    }
  } else {
    notes.push(`${someNames(targets)}.`);
  }
  notes.push(...linkedNote(kept));
  return {
    change: { kind: "delete", skills: targets.map(skillRef) },
    affected: targets.length,
    confirmation: {
      title:
        targets.length === 1 ? `Delete ${targets[0]!.name}?` : `Delete ${targets.length} skills?`,
      body:
        targets.length === 1
          ? `This deletes ${targets[0]!.home} and any links to it. It can't be undone.`
          : `This deletes ${plural(targets.length, "folder")} and any links to them. It can't be undone.`,
      notes,
      confirm: "Delete",
      destructive: true,
    },
  };
}

/**
 * The project skills a confirmation should ask git about: those a delete removes or a placement
 * takes out of their project. A move into a project makes new files, so there is nothing in git
 * to undo. Null when the plan has nothing to ask about.
 */
export function skillsToCheckWithGit(plan: SkillPlan): readonly SkillRef[] | null {
  const { change } = plan;
  if (plan.confirmation === undefined) return null;
  if (change.kind === "enable" || change.kind === "disable") return null;
  if (change.kind === "place" && change.to.kind === "project") return null;
  const skills = change.skills.filter((skill) => skill.scope === "project");
  return skills.length === 0 ? null : skills;
}

/**
 * The plan with a line saying git can undo it, once the server has said which project skills it
 * tracks. A plan nothing is tracked for is returned as it was.
 */
export function withGitNote(plan: SkillPlan, tracked: readonly string[]): SkillPlan {
  if (plan.confirmation === undefined) return plan;
  const { skills } = plan.change;
  const names = new Set(tracked);
  const count = skills.filter((skill) => skill.scope === "project" && names.has(skill.name)).length;
  if (count === 0) return plan;
  const note =
    count === skills.length
      ? "You can undo this with git."
      : `${count} of these ${count === 1 ? "is" : "are"} tracked by git, so you can undo ${count === 1 ? "that one" : "those"} with git.`;
  return {
    ...plan,
    confirmation: { ...plan.confirmation, notes: [...plan.confirmation.notes, note] },
  };
}

/** A one-click fix for a skill that installed agents can't use yet. */
export function planFix(skill: Skill, ctx: SkillsContext) {
  const missing = missingAgents(skill, ctx).filter((agent) => !isFixed(skill, agent));
  if (missing.length === 0) return null;
  return {
    label:
      missing.length === 1 ? `Turn on for ${missing[0]!.displayName}` : "Turn on for all agents",
    plan: enablePlan([skill], missing),
  };
}

const problemText = (
  reason: SkillOutcomeReason,
  name: string,
  who: string | undefined,
  /** Where a placement was going, to say who is in the way. */
  where?: string,
) => {
  switch (reason) {
    case "notFound":
      return `“${name}” isn't there any more.`;
    case "changed":
      return `“${name}” changed since the list was read.`;
    case "alwaysOn":
      return `${who ?? "An agent"} reads “${name}” directly, so it stays on.`;
    case "entryTaken":
      return `${who ?? "An agent"} already has a different “${name}”.`;
    case "shadowed":
      return `${who ?? "An agent"} loads another “${name}” first.`;
    case "linkNotAllowed":
      return "Your system doesn't let T3 Code make links there. On Windows, turn on Developer Mode.";
    case "linked":
      return `“${name}” is reached through a link, so it stays where it is.`;
    case "destinationTaken":
      return `${where ?? "The other side"} already has a “${name}”, so it stays.`;
    case "inUse":
      return `“${name}” is in use by another program, so it wasn't moved.`;
    case "setElsewhere":
      return `${who ?? "An agent"}'s settings decide “${name}”, so it stays as it is.`;
    case "failed":
      return who === undefined
        ? `Couldn't change “${name}”.`
        : `Couldn't change ${who}'s folder for “${name}”.`;
  }
};

/** Many skills held back for the same agent and reason are one sentence, not one each. */
const manyProblemText = (reason: SkillOutcomeReason, who: string, count: number) =>
  reason === "alwaysOn"
    ? `${who} reads ${count} skills directly, so they stay on.`
    : `${who}'s settings decide ${count} skills, so they stay as they are.`;

const AGGREGATED_REASONS = new Set<SkillOutcomeReason>(["alwaysOn", "setElsewhere"]);

/** Where a placement went, as the start of a sentence naming who is in the way. */
const placeWhere = (change: Extract<SkillChange, { kind: "place" }>) =>
  change.to.kind === "global"
    ? "Global"
    : change.to.kind === "project"
      ? (change.projectNames[0] ?? "This project")
      : "A project";

/** A skill that was changed, but not all the way: its old folder stayed, or only some of it went. */
const partialText = (kind: SkillChange["kind"], name: string) =>
  kind === "place"
    ? `“${name}” moved, but its old folder couldn't be removed.`
    : `“${name}” was only partly deleted.`;

const MAX_PROBLEMS = 3;

/** One status line on what a change did, from what the server says happened to each skill. */
export function describeResult(
  change: SkillChange,
  outcomes: readonly SkillOutcome[],
  ctx: SkillsContext,
) {
  const nameOf = (id: ProviderInstanceId) =>
    ctx.installed.find((agent) => agent.instanceId === id)?.displayName ?? id;
  const changed = outcomes.filter((outcome) => outcome.status === "changed");
  const also = [...new Set(changed.flatMap((outcome) => outcome.affected.map(nameOf)))];
  const alsoNames = joinNames(also);
  const them = changed.length === 1 ? "it" : "them";
  const alsoText = (verb: string) =>
    also.length > 0 ? ` ${alsoNames} ${also.length === 1 ? `${verb}s` : verb} ${them} too.` : "";
  const lead = (() => {
    if (changed.length === 0) return "";
    const count = plural(changed.length, "skill");
    switch (change.kind) {
      case "enable":
        return `Turned on ${count} for ${joinNames(change.agents.map(nameOf))}.${alsoText("get")}`;
      case "disable":
        return `Turned off ${count} for ${joinNames(change.agents.map(nameOf))}.${also.length > 0 ? ` ${alsoNames} ${also.length === 1 ? "loses" : "lose"} ${them} too.` : ""}`;
      case "place":
        return `${
          change.to.kind === "global"
            ? `Made ${count} Global.`
            : change.to.kind === "project"
              ? `Moved ${count} to ${change.projectNames[0] ?? "this project"}.`
              : `${count} now used in ${joinNames(change.projectNames)}.`
        }${alsoText("get")}`;
      case "delete":
        return `Deleted ${count}.`;
    }
  })();
  // A skill whose record of where it came from couldn't go along won't be updated from there.
  const dropped = changed.filter((outcome) => outcome.sourceDropped === true);
  const droppedText = (() => {
    const [first] = dropped;
    if (first === undefined) return "";
    if (dropped.length > 1) {
      return `${plural(dropped.length, "skill")} won't update from their sources any more.`;
    }
    const source =
      change.kind === "place"
        ? change.sources?.[`${first.skill.scope}\0${first.skill.name}\0${first.skill.home}`]
        : undefined;
    return `${first.skill.name} won't update${source === undefined ? "" : ` from ${source}`} any more.`;
  })();
  // Skills held back for the same agent and reason are counted once, so a bulk change stays short.
  const held = new Map<string, number>();
  for (const outcome of outcomes) {
    for (const blocked of outcome.blocked) {
      if (!AGGREGATED_REASONS.has(blocked.reason)) continue;
      const key = `${blocked.reason}\0${blocked.instanceId}`;
      held.set(key, (held.get(key) ?? 0) + 1);
    }
  }
  const problems = [
    ...new Set(
      outcomes.flatMap((outcome) => [
        ...(outcome.reason
          ? [
              outcome.status === "changed" &&
              outcome.reason === "failed" &&
              (change.kind === "place" || change.kind === "delete")
                ? partialText(change.kind, outcome.skill.name)
                : problemText(
                    outcome.reason,
                    outcome.skill.name,
                    undefined,
                    change.kind === "place" ? placeWhere(change) : undefined,
                  ),
            ]
          : []),
        ...outcome.blocked.map((blocked) => {
          const count = held.get(`${blocked.reason}\0${blocked.instanceId}`) ?? 0;
          return count > 1
            ? manyProblemText(blocked.reason, nameOf(blocked.instanceId), count)
            : problemText(blocked.reason, outcome.skill.name, nameOf(blocked.instanceId));
        }),
      ]),
    ),
  ];
  if (lead === "" && problems.length === 0) {
    switch (change.kind) {
      case "enable":
        return "Already on.";
      case "disable":
        return "Already off.";
      case "place":
        return "Already there.";
      case "delete":
        return "Nothing to delete.";
    }
  }
  const shown = problems.slice(0, MAX_PROBLEMS);
  if (problems.length > shown.length) {
    shown.push(`${problems.length - shown.length} more couldn't be changed.`);
  }
  return [lead, droppedText, ...shown].filter((part) => part !== "").join(" ");
}

// -- Big changes ------------------------------------------------------------------------------

/** The server takes at most this many skills in one change. */
const MAX_SKILLS_PER_CALL = 200;

/**
 * Sends a change in batches the server accepts, one after the other, and puts the outcomes
 * together in order. A batch the server answered nothing for stops the rest, since the page reads
 * the folders again afterwards: what was done stays done, and `failed` says the change is not
 * complete.
 */
export async function sendInBatches(
  skills: readonly SkillRef[],
  send: (batch: readonly SkillRef[]) => Promise<readonly SkillOutcome[] | null>,
) {
  const outcomes: SkillOutcome[] = [];
  for (let start = 0; start < skills.length; start += MAX_SKILLS_PER_CALL) {
    const batch = await send(skills.slice(start, start + MAX_SKILLS_PER_CALL));
    if (batch === null) return { outcomes, failed: true };
    outcomes.push(...batch);
  }
  return { outcomes, failed: false };
}

// -- Search -----------------------------------------------------------------------------------

export const matchesQuery = (skill: Skill, needle: string) =>
  `${skill.name} ${skill.description}`.toLowerCase().includes(needle);

/** Files an agent could run, shown as a warning in the skill view. */
const SCRIPT_FILE = /\.(?:sh|mjs|ts|py)$/;
export function scriptFiles(files: ReadonlyArray<{ path: string; executable: boolean }>) {
  return files
    .filter(
      (file) =>
        file.path !== "SKILL.md" &&
        (file.path.startsWith("bin/") || SCRIPT_FILE.test(file.path) || file.executable),
    )
    .map((file) => file.path);
}

// -- Files and SKILL.md -----------------------------------------------------------------------

/** Sort entry as the file tree hands it over. */
type FileSortEntry = { path: string; isDirectory: boolean; segments: readonly string[] };

/** The tree's usual order (folders first, then names), with the root SKILL.md pinned on top. */
export function compareSkillFiles(left: FileSortEntry, right: FileSortEntry) {
  const pinned = Number(right.path === "SKILL.md") - Number(left.path === "SKILL.md");
  if (pinned !== 0) return pinned;
  const shared = Math.min(left.segments.length, right.segments.length);
  for (let depth = 0; depth < shared; depth += 1) {
    const a = left.segments[depth]!;
    const b = right.segments[depth]!;
    if (a === b) continue;
    const aFolder = depth < left.segments.length - 1 || left.isDirectory;
    const bFolder = depth < right.segments.length - 1 || right.isDirectory;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return (
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) || (a < b ? -1 : 1)
    );
  }
  return left.segments.length - right.segments.length;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const BLANK_LINES = /^(?:[ \t]*\r?\n)*/;

/** The instructions after the frontmatter, without the blank line that separates them. */
export function skillBody(contents: string) {
  const match = FRONTMATTER.exec(contents);
  const rest = match ? contents.slice(match[0].length) : contents;
  return rest.slice(BLANK_LINES.exec(rest)![0].length);
}
