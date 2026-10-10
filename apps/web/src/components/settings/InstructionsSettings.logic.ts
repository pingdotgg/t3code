import type {
  ClaudeInstructionChoice,
  ClaudeInstructionValue,
  InstructionAgentAccess,
  InstructionAgentsResult,
  InstructionEntry,
  InstructionError,
  InstructionListResult,
  ProviderInstanceId,
} from "@t3tools/contracts";

import {
  joinNames,
  type PlanConfirmation,
  type SkillAgent,
  type SkillsContext,
} from "./SkillsSettings.logic";

/** The first Claude Code version with the "Project instructions" setting. */
const CLAUDE_SETTING_VERSION = "2.1.277";

const GIT_UNDO_NOTE = "You can undo this with git.";
/** Said instead of the above when the same change also sets Claude, which git doesn't track. */
const GIT_UNDO_FILE_NOTE = "You can undo the file change with git.";
const CANT_UNDO_NOTE = "This can't be undone.";

/** The project's AGENTS.md, which a merge writes to. */
const PROJECT_AGENTS_ID = "project:shared:AGENTS.md";

// -- Reading the list ---------------------------------------------------------------------------

export function ingestInstructions(result: InstructionListResult) {
  const known = new Set<ProviderInstanceId>([
    ...result.entries.flatMap((entry) => entry.access.map((access) => access.instanceId)),
    ...result.claude.map((choice) => choice.instanceId),
  ]);
  return {
    entries: result.entries,
    claude: result.claude,
    sharedPath: result.sharedPath,
    unreadable: result.unreadable,
    known,
  };
}

export type InstructionData = ReturnType<typeof ingestInstructions>;

const agentOf = (ctx: SkillsContext, instanceId: ProviderInstanceId) =>
  ctx.installed.find((agent) => agent.instanceId === instanceId);

const accessFor = (entry: InstructionEntry, agent: Pick<SkillAgent, "instanceId">) =>
  entry.access.find((access) => access.instanceId === agent.instanceId);

/** The agents that appear in the entry's access list, which are the ones it can say anything about. */
const listedAgents = (entry: InstructionEntry, ctx: SkillsContext) =>
  ctx.installed.filter((agent) => accessFor(entry, agent) !== undefined);

const reads = (access: InstructionAgentAccess | undefined) =>
  access !== undefined && access.state !== "none";

const isClaude = (agent: SkillAgent) => agent.driverKind === "claudeAgent";

/** The name of a file, for a search and a note. */
export const entryFileName = (entry: InstructionEntry) =>
  entry.relativePath ?? entry.path.split(/[\\/]/).at(-1) ?? entry.path;

/** The project's own AGENTS.md, which the list calls "This project". */
const isProjectAgentsFile = (entry: InstructionEntry) =>
  entry.scope === "project" &&
  entry.kind === "shared" &&
  (entry.relativePath === undefined || entry.relativePath === "AGENTS.md");

/** The Global file: the one every project and any agent can share. */
const isGlobalFile = (entry: InstructionEntry) =>
  entry.scope === "global" && entry.kind === "shared";

/** The project's CLAUDE.md in its top folder, the one that can become AGENTS.md. */
const isProjectClaudeFile = (entry: InstructionEntry) =>
  entry.scope === "project" &&
  entry.kind === "claude" &&
  (entry.relativePath === undefined || entry.relativePath === "CLAUDE.md");

// -- Who uses a file ----------------------------------------------------------------------------

export type Usage = {
  /** Every agent that can read this kind of file does. */
  everyone: boolean;
  /** Agents that read it. */
  agents: SkillAgent[];
  /** Agents that could but don't. */
  missing: SkillAgent[];
};

export function usage(entry: InstructionEntry, ctx: SkillsContext): Usage {
  const listed = listedAgents(entry, ctx);
  const agents = listed.filter((agent) => reads(accessFor(entry, agent)));
  return {
    everyone: listed.length > 0 && agents.length === listed.length,
    agents,
    missing: listed.filter((agent) => !reads(accessFor(entry, agent))),
  };
}

/** The tooltip on a row's agent icons. */
export const usageNote = (value: Usage) =>
  value.everyone
    ? "Used by all your agents"
    : `Not used by ${joinNames(value.missing.map((agent) => agent.displayName))}`;

// -- Plans --------------------------------------------------------------------------------------

/** What to ask the server for. */
export type InstructionChange =
  | {
      readonly kind: "setClaude";
      readonly instances: readonly ProviderInstanceId[];
      /** Null goes back to Claude's default. */
      readonly value: ClaudeInstructionValue | null;
    }
  | {
      readonly kind: "enable" | "disable";
      readonly id: string;
      readonly agents: readonly ProviderInstanceId[];
    }
  | {
      readonly kind: "adopt";
      /** One file per agent that moves over, each adopted by its own request. */
      readonly ids: readonly string[];
      readonly names: readonly string[];
    }
  | {
      readonly kind: "share";
      readonly id: string;
      readonly project: boolean;
      /** The project already has an AGENTS.md, so CLAUDE.md's text goes at its end. */
      readonly merge: boolean;
      /** Claude instances the same plan sets to read AGENTS.md in every project afterwards. */
      readonly claude: readonly ProviderInstanceId[];
    }
  | {
      readonly kind: "delete";
      readonly id: string;
      readonly name: string;
      readonly project: boolean;
    };

export type InstructionPlan = {
  readonly change: InstructionChange;
  /** Present when the change should be confirmed first. */
  readonly confirmation?: PlanConfirmation;
};

const claudeNames = (instances: readonly ProviderInstanceId[], ctx: SkillsContext) =>
  joinNames(instances.map((id) => agentOf(ctx, id)?.displayName ?? "Claude"));

/** Claude reads AGENTS.md next to its CLAUDE.md files, in every project. */
export function planClaudeAgents(
  instances: readonly ProviderInstanceId[],
  ctx: SkillsContext,
): InstructionPlan {
  const names = claudeNames(instances, ctx);
  return {
    change: { kind: "setClaude", instances, value: "claude-md-and-agents-md" },
    confirmation: {
      title: `Turn on AGENTS.md for ${names}?`,
      body: `${names} will read AGENTS.md in every project, together with your CLAUDE.md files.`,
      notes: [],
      confirm: "Turn on",
      destructive: false,
    },
  };
}

/** Claude stops reading AGENTS.md, in every project. */
function planClaudeNever(
  instances: readonly ProviderInstanceId[],
  ctx: SkillsContext,
): InstructionPlan {
  const names = claudeNames(instances, ctx);
  return {
    change: { kind: "setClaude", instances, value: "claude-md" },
    confirmation: {
      title: `Turn off AGENTS.md for ${names}?`,
      body: `${names} will stop reading AGENTS.md in every project.`,
      notes: [],
      confirm: "Turn off",
      destructive: false,
    },
  };
}

const enablePlan = (
  id: string,
  kind: "enable" | "disable",
  agents: readonly SkillAgent[],
): InstructionPlan => ({
  change: { kind, id, agents: agents.map((agent) => agent.instanceId) },
});

type OwnFile = { readonly entry: InstructionEntry; readonly name: string };

/** Agents' own files move into Global, and each agent uses Global from then on. */
function planAdopt(files: readonly OwnFile[]): InstructionPlan {
  const names = joinNames(files.map((file) => file.name));
  const many = files.length > 1;
  const same = files.every((file) => file.entry.sameAsShared === true);
  return {
    change: {
      kind: "adopt",
      ids: files.map((file) => file.entry.id),
      names: files.map((file) => file.name),
    },
    confirmation: {
      title: `Use your Global instructions for ${names}?`,
      body: same
        ? `${names}'s instructions match your Global instructions, so ${many ? "they just start" : `${names} just starts`} using them.`
        : `${names}'s instructions are added to your Global instructions. ${many ? "They then read them" : `${names} then reads them`} instead.`,
      notes: [],
      confirm: "Use Global instead",
      destructive: false,
    },
  };
}

// -- What Claude does once the project's CLAUDE.md is gone ---------------------------------------

type ClaudeAfter =
  | { readonly kind: "reads" }
  /** The setting would keep it from AGENTS.md: a file in the way, or null for "Never". */
  | { readonly kind: "skips"; readonly blocker: string | null }
  | { readonly kind: "old" }
  | { readonly kind: "managed" };

type ClaudeInstance = { readonly agent: SkillAgent; readonly after: ClaudeAfter };

/**
 * Whether each installed Claude would read the project's AGENTS.md once the top folder's
 * CLAUDE.md is gone, from its choice and the files that remain. Under the default a
 * `.claude/CLAUDE.md` or a CLAUDE.local.md still keeps Claude from AGENTS.md. A remaining file that
 * imports AGENTS.md isn't looked for.
 */
function claudeAfterClaudeMd(
  ctx: SkillsContext,
  data: Pick<InstructionData, "entries" | "claude">,
): ClaudeInstance[] {
  const blocker = [".claude/CLAUDE.md", "CLAUDE.local.md"].find((name) =>
    data.entries.some(
      (entry) =>
        entry.scope === "project" &&
        entry.exists &&
        (entry.kind === "claude" || entry.kind === "claudeLocal") &&
        entryFileName(entry) === name,
    ),
  );
  return data.claude.flatMap((choice): ClaudeInstance[] => {
    const agent = agentOf(ctx, choice.instanceId);
    if (!agent) return [];
    const after = ((): ClaudeAfter => {
      if (choice.value === "managed-only") return { kind: "managed" };
      if (!choice.supported) return { kind: "old" };
      if (choice.value === "claude-md-and-agents-md") return { kind: "reads" };
      if (choice.value === "claude-md") return { kind: "skips", blocker: null };
      return blocker === undefined ? { kind: "reads" } : { kind: "skips", blocker };
    })();
    return [{ agent, after }];
  });
}

/** Claude by that name, or by the instance's own when there are several. */
const claudeLabel = (instance: ClaudeInstance, all: readonly ClaudeInstance[]) =>
  all.length > 1 ? instance.agent.displayName : "Claude";

/** The lines on what a move or merge means for Claude, one per kind of answer. */
function claudeParagraphs(all: readonly ClaudeInstance[]) {
  const several = all.length > 1;
  const group = (pick: (instance: ClaudeInstance) => string | undefined) => {
    const groups = new Map<string, ClaudeInstance[]>();
    for (const instance of all) {
      const key = pick(instance);
      if (key === undefined) continue;
      groups.set(key, [...(groups.get(key) ?? []), instance]);
    }
    return [...groups].map(([key, found]) => ({
      key,
      who: joinNames(found.map((instance) => claudeLabel(instance, all))),
      many: found.length > 1,
    }));
  };
  return [
    ...group((instance) =>
      instance.after.kind === "skips" ? (instance.after.blocker ?? "") : undefined,
    ).map(({ key, who, many }) =>
      key === ""
        ? `${who} ${many ? "are" : "is"} set to never read AGENTS.md, so this also turns it on for ${who} in every project.`
        : `${who} ${many ? "skip" : "skips"} AGENTS.md when there's a ${key}, so this also turns AGENTS.md on for ${who} in every project.`,
    ),
    ...group((instance) => (instance.after.kind === "old" ? "" : undefined)).map(({ who, many }) =>
      several
        ? `${who} ${many ? "need" : "needs"} Claude Code ${CLAUDE_SETTING_VERSION} or later to read AGENTS.md.`
        : `Claude Code needs version ${CLAUDE_SETTING_VERSION} or later to read AGENTS.md.`,
    ),
    ...group((instance) => (instance.after.kind === "managed" ? "" : undefined)).map(
      ({ who, many }) =>
        `Your organization decides whether ${who} ${many ? "read" : "reads"} AGENTS.md.`,
    ),
  ];
}

/** The project's CLAUDE.md becomes AGENTS.md, or joins the AGENTS.md that is already there. */
function planShare(
  entry: InstructionEntry,
  ctx: SkillsContext,
  data: Pick<InstructionData, "entries" | "claude">,
): InstructionPlan {
  const merge = hasProjectAgentsFile(data.entries);
  const missing = usage(entry, ctx).missing;
  const claude = claudeAfterClaudeMd(ctx, data);
  const turnOn = claude.filter((instance) => instance.after.kind === "skips");
  const extra = claudeParagraphs(claude);
  const lead = merge
    ? `Its text goes at the end of AGENTS.md, then CLAUDE.md is deleted.${turnOn.length > 0 ? "" : " Every agent reads AGENTS.md from then on."}`
    : missing.length === 0
      ? "Every agent reads AGENTS.md."
      : `Every agent reads AGENTS.md, so ${joinNames(missing.map((agent) => agent.displayName))} ${missing.length === 1 ? "gets" : "get"} these instructions too.`;
  return {
    change: {
      kind: "share",
      id: entry.id,
      project: entry.scope === "project",
      merge,
      claude: turnOn.map((instance) => instance.agent.instanceId),
    },
    confirmation: {
      title: merge ? "Merge CLAUDE.md into AGENTS.md?" : "Move CLAUDE.md to AGENTS.md?",
      body: [lead, ...extra].join("\n\n"),
      notes: [],
      confirm: merge ? "Merge" : "Move",
      destructive: false,
    },
  };
}

/** Taking the Global file away from the agents that read it. The file stays. */
function planRemove(entry: InstructionEntry, agents: readonly SkillAgent[]): InstructionPlan {
  return {
    change: { kind: "disable", id: entry.id, agents: agents.map((agent) => agent.instanceId) },
    confirmation: {
      title: "Stop using your Global instructions?",
      body: `${joinNames(agents.map((agent) => agent.displayName))} will stop reading them. The file isn't deleted.`,
      notes: [],
      confirm: "Remove",
      destructive: true,
    },
  };
}

function planDelete(
  entry: InstructionEntry,
  name: string,
  ctx: SkillsContext,
  data: Pick<InstructionData, "entries" | "claude">,
): InstructionPlan {
  // The project's AGENTS.md takes over for a CLAUDE.md that every Claude then reads it instead of.
  const claude = claudeAfterClaudeMd(ctx, data);
  const replaced =
    isProjectClaudeFile(entry) &&
    hasProjectAgentsFile(data.entries) &&
    claude.length > 0 &&
    claude.every((instance) => instance.after.kind === "reads");
  return {
    change: {
      kind: "delete",
      id: entry.id,
      name,
      project: entry.scope === "project",
    },
    confirmation: {
      title: `Delete ${name}?`,
      body: replaced
        ? `${joinNames(claude.map((instance) => claudeLabel(instance, claude)))} ${claude.length > 1 ? "read" : "reads"} AGENTS.md instead.`
        : `This deletes ${name}.`,
      notes: [CANT_UNDO_NOTE],
      confirm: "Delete",
      destructive: true,
    },
  };
}

/** The project file ids a confirmation should ask git about, or null when it has nothing to ask. */
export function instructionsToCheckWithGit(plan: InstructionPlan): readonly string[] | null {
  const { change } = plan;
  if (plan.confirmation === undefined) return null;
  if (change.kind === "share" && change.project) {
    return change.merge ? [change.id, PROJECT_AGENTS_ID] : [change.id];
  }
  return change.kind === "delete" && change.project ? [change.id] : null;
}

/**
 * The plan with a line saying git can undo it, once the server has said which of its files git
 * tracks. A file git doesn't track keeps its plan as it was, and a merge needs both of its files
 * tracked. A change that also sets Claude can only be undone in part.
 */
export function withInstructionGitNote(
  plan: InstructionPlan,
  tracked: readonly string[],
): InstructionPlan {
  const { change, confirmation } = plan;
  if (!confirmation || (change.kind !== "share" && change.kind !== "delete")) return plan;
  const files =
    change.kind === "share" && change.merge ? [change.id, PROJECT_AGENTS_ID] : [change.id];
  if (!files.every((id) => tracked.includes(id))) return plan;
  const note =
    change.kind === "share" && change.claude.length > 0 ? GIT_UNDO_FILE_NOTE : GIT_UNDO_NOTE;
  return {
    ...plan,
    confirmation: {
      ...confirmation,
      notes: [...confirmation.notes.filter((item) => item !== CANT_UNDO_NOTE), note],
    },
  };
}

// -- Rows ---------------------------------------------------------------------------------------

export type InstructionFix = { readonly label: string; readonly plan: InstructionPlan };

export type InstructionAttention = {
  /** One plain sentence on what is wrong. */
  readonly detail: string;
  readonly fix: InstructionFix | null;
};

/** The two headings of the Instructions card. */
export type InstructionGroup = "project" | "global";

const GROUP_LABEL: Record<InstructionGroup, string> = { project: "Project", global: "Global" };

export type InstructionRow = {
  readonly id: string;
  readonly entry: InstructionEntry;
  /** The row's title in the list: the file's name. */
  readonly title: string;
  /** The title of the open file. */
  readonly heading: string;
  /** The line under the title of the open file: its group, or the folder of a subfolder file. */
  readonly headingNote: string;
  /** The heading the row sits under in the list. */
  readonly group: InstructionGroup;
  /** The file isn't there yet, and the row offers to create it. */
  readonly missing: boolean;
  /** Clicking the row opens one switch per agent in place; the Global file does once it exists. */
  readonly expandable: boolean;
  readonly attention: InstructionAttention | null;
  /** Where the row sits in the list. */
  readonly rank: number;
};

type Labels = Pick<InstructionRow, "title" | "heading" | "headingNote">;

/** The folder and file name of a file in a subfolder, such as `apps/web` and `AGENTS.md`. */
function splitNested(entry: InstructionEntry) {
  const path = entry.relativePath ?? entryFileName(entry);
  const cut = path.lastIndexOf("/");
  return { folder: cut < 0 ? "" : path.slice(0, cut), file: path.slice(cut + 1) };
}

/**
 * What a file is called, or null for one the list doesn't show. A title is the file's name; the
 * open file's note says whether it is the project's or Global.
 */
function labelsFor(
  entry: InstructionEntry,
  ctx: SkillsContext,
  entries: readonly InstructionEntry[],
): Labels | null {
  const name = entryFileName(entry);
  const named = (title: string, headingNote: string): Labels => ({
    title,
    heading: title,
    headingNote,
  });
  switch (entry.scope) {
    case "managed":
      return named("Set by your organization", name);
    case "project": {
      if (isProjectAgentsFile(entry)) return named("AGENTS.md", GROUP_LABEL.project);
      if (entry.kind === "nested") {
        const { folder, file } = splitNested(entry);
        return named(file, folder ? `In ${folder}` : GROUP_LABEL.project);
      }
      return named(name, GROUP_LABEL.project);
    }
    case "global": {
      if (entry.kind === "shared") return named("AGENTS.md", GROUP_LABEL.global);
      // An agent's own file belongs to an agent that is installed and enabled.
      const owner = entry.owner === undefined ? undefined : agentOf(ctx, entry.owner);
      if (owner === undefined) return null;
      if (entry.kind === "claude") {
        // Two Claude instances each have a CLAUDE.md, so each says whose it is.
        const several =
          entries.filter(
            (other) =>
              other.scope === "global" &&
              other.kind === "claude" &&
              other.owner !== undefined &&
              agentOf(ctx, other.owner) !== undefined,
          ).length > 1;
        return named(several ? `${owner.displayName}'s ${name}` : name, GROUP_LABEL.global);
      }
      return named(`${owner.displayName}'s ${name}`, GROUP_LABEL.global);
    }
  }
}

/** Order in the list: the project's files, then Global, then each agent's own, then the organization. */
function rank(entry: InstructionEntry) {
  if (entry.scope === "project") {
    if (entry.kind === "shared") return 0;
    return entry.kind === "claude" ? 1 : 2;
  }
  if (entry.scope === "global") {
    if (entry.kind === "shared") return 4;
    return entry.kind === "claude" ? 5 : 6;
  }
  return 7;
}

/** Agents that don't read the entry and could be switched on, with the reason that blocks them left out. */
function switchableAgents(entry: InstructionEntry, ctx: SkillsContext) {
  return listedAgents(entry, ctx).filter((agent) => {
    const access = accessFor(entry, agent);
    return (
      access?.state === "none" && access.reason !== "ownFile" && access.reason !== "oldVersion"
    );
  });
}

/** An agent's own Global file, when it has one: the one that keeps the agent from reading Global. */
const ownGlobalFile = (
  agent: Pick<SkillAgent, "instanceId">,
  entries: readonly InstructionEntry[],
) =>
  entries.find(
    (other) =>
      other.scope === "global" &&
      other.kind === "agentOwn" &&
      other.exists &&
      other.owner === agent.instanceId,
  );

function attentionFor(
  entry: InstructionEntry,
  ctx: SkillsContext,
  data: Pick<InstructionData, "entries" | "claude">,
): InstructionAttention | null {
  if (!entry.exists || entry.readOnly) return null;
  if (isProjectAgentsFile(entry)) {
    const skipped = listedAgents(entry, ctx).filter(
      (agent) => isClaude(agent) && accessFor(entry, agent)?.reason === "claudeFiles",
    );
    if (skipped.length === 0) return null;
    const files = [
      ...new Set(skipped.map((agent) => accessFor(entry, agent)?.blockingFile ?? "CLAUDE.md")),
    ];
    const names = joinNames(skipped.map((agent) => agent.displayName));
    return {
      detail: `${names} ${skipped.length === 1 ? "skips" : "skip"} it because of ${joinNames(files)}`,
      fix: {
        label: `Turn on for ${skipped.length === 1 ? skipped[0]!.displayName : "Claude"}`,
        plan: planClaudeAgents(
          skipped.map((agent) => agent.instanceId),
          ctx,
        ),
      },
    };
  }
  if (isGlobalFile(entry)) {
    const missing = switchableAgents(entry, ctx);
    if (missing.length > 0) {
      return {
        detail: `Not used by ${joinNames(missing.map((agent) => agent.displayName))}`,
        fix: {
          label:
            missing.length === 1
              ? `Turn on for ${missing[0]!.displayName}`
              : "Turn on for all agents",
          plan: enablePlan(entry.id, "enable", missing),
        },
      };
    }
    // What is left is agents that keep a file of their own, which Global can take over.
    const own = listedAgents(entry, ctx).flatMap((agent): OwnFile[] => {
      if (accessFor(entry, agent)?.reason !== "ownFile") return [];
      const file = ownGlobalFile(agent, data.entries);
      return file ? [{ entry: file, name: agent.displayName }] : [];
    });
    if (own.length === 0) return null;
    return {
      detail: `${joinNames(own.map((file) => file.name))} ${own.length === 1 ? "uses its" : "use their"} own AGENTS.md instead`,
      fix: { label: "Use Global instead", plan: planAdopt(own) },
    };
  }
  if (isProjectClaudeFile(entry)) {
    const missing = usage(entry, ctx).missing;
    if (missing.length === 0) return null;
    return {
      detail: `Not used by ${joinNames(missing.map((agent) => agent.displayName))}`,
      fix: shareFix(entry, ctx, data),
    };
  }
  return null;
}

const hasProjectAgentsFile = (entries: readonly InstructionEntry[]) =>
  entries.some((entry) => isProjectAgentsFile(entry) && entry.exists);

/** Moving the project's CLAUDE.md to AGENTS.md, or merging it into the one that is there. */
const shareFix = (
  entry: InstructionEntry,
  ctx: SkillsContext,
  data: Pick<InstructionData, "entries" | "claude">,
): InstructionFix => ({
  label: hasProjectAgentsFile(data.entries) ? "Merge into AGENTS.md" : "Move to AGENTS.md",
  plan: planShare(entry, ctx, data),
});

function buildRow(
  entry: InstructionEntry,
  ctx: SkillsContext,
  data: Pick<InstructionData, "entries" | "claude">,
): InstructionRow | null {
  const labels = labelsFor(entry, ctx, data.entries);
  if (!labels) return null;
  return {
    id: entry.id,
    entry,
    ...labels,
    group: entry.scope === "project" ? "project" : "global",
    missing: !entry.exists,
    expandable: isGlobalFile(entry) && entry.exists,
    attention: attentionFor(entry, ctx, data),
    rank: rank(entry),
  };
}

/**
 * The files the Instructions section lists: the ones that exist, plus a missing project AGENTS.md,
 * CLAUDE.local.md and Global file, so there is something to create. Subfolder files are listed
 * together in `nestedFiles`, and an agent's own Global file shows as a line on the Global file
 * instead. A top-folder CLAUDE.md row takes the place of a missing project AGENTS.md, since moving
 * it to AGENTS.md creates that file. Apart from the AGENTS.md files, a file no installed agent reads has no row, such as
 * CLAUDE.md with Claude off.
 */
export function instructionRows(
  data: Pick<InstructionData, "entries" | "claude">,
  ctx: SkillsContext,
): InstructionRow[] {
  const listed = data.entries.filter(
    (entry) =>
      entry.kind !== "nested" &&
      entry.kind !== "agentOwn" &&
      (entry.exists || entry.kind === "shared" || entry.kind === "claudeLocal") &&
      (entry.kind === "shared" || usage(entry, ctx).agents.length > 0),
  );
  const hasProjectClaude = listed.some(isProjectClaudeFile);
  return listed
    .filter((entry) => !(hasProjectClaude && isProjectAgentsFile(entry) && !entry.exists))
    .map((entry, index) => ({ row: buildRow(entry, ctx, data), index }))
    .flatMap((item) => (item.row ? [{ ...item, row: item.row }] : []))
    .sort((a, b) => a.row.rank - b.row.rank || a.index - b.index)
    .map(({ row }) => row);
}

/** One file by id, to open it. A subfolder file and an agent's own Global file are found here too. */
export function findInstructionRow(
  data: Pick<InstructionData, "entries" | "claude">,
  ctx: SkillsContext,
  id: string,
): InstructionRow | null {
  const entry = data.entries.find((candidate) => candidate.id === id);
  return entry ? buildRow(entry, ctx, data) : null;
}

// -- Claude's choice ----------------------------------------------------------------------------

export type ClaudeOption = {
  readonly value: ClaudeInstructionValue;
  readonly label: string;
  readonly hint?: string;
};

export const CLAUDE_OPTIONS: readonly ClaudeOption[] = [
  { value: "claude-md-or-agents-md", label: "When there's no CLAUDE.md", hint: "Claude's default" },
  { value: "claude-md-and-agents-md", label: "Alongside any CLAUDE.md" },
  { value: "claude-md", label: "Never" },
];

const CLAUDE_DEFAULT: ClaudeInstructionValue = "claude-md-or-agents-md";

export type ClaudeRow = {
  readonly instanceId: ProviderInstanceId;
  readonly agent: SkillAgent;
  readonly choice: ClaudeInstructionChoice;
  readonly title: string;
  /** A line under the title on why the choice can't be changed; null when it can. */
  readonly note: string | null;
  readonly control:
    | {
        readonly kind: "select";
        readonly value: ClaudeInstructionValue;
        readonly label: string;
        readonly disabled: boolean;
      }
    | { readonly kind: "text"; readonly text: string };
};

/** One row per enabled Claude instance that is installed. With several, each is named. */
export function claudeRows(
  choices: readonly ClaudeInstructionChoice[],
  ctx: SkillsContext,
): ClaudeRow[] {
  const shown = choices.flatMap((choice) => {
    const agent = agentOf(ctx, choice.instanceId);
    return agent ? [{ choice, agent }] : [];
  });
  return shown.map(({ choice, agent }): ClaudeRow => {
    const managed = choice.value === "managed-only";
    return {
      instanceId: choice.instanceId,
      agent,
      choice,
      title: `${shown.length > 1 ? agent.displayName : "Claude"} reads AGENTS.md`,
      note:
        !choice.supported && !managed
          ? `Needs Claude Code ${CLAUDE_SETTING_VERSION} or later`
          : null,
      control: managed
        ? { kind: "text", text: "Organization only" }
        : {
            kind: "select",
            value: choice.value,
            label: CLAUDE_OPTIONS.find((option) => option.value === choice.value)?.label ?? "",
            disabled: !choice.supported,
          },
    };
  });
}

/**
 * What picking an option asks for. Claude's default is stored as no value at all, so picking it
 * removes the setting; picking what already applies asks for nothing.
 */
export function claudeChange(
  choice: Pick<ClaudeInstructionChoice, "instanceId" | "value" | "explicit">,
  picked: ClaudeInstructionValue,
): InstructionChange | null {
  if (picked === CLAUDE_DEFAULT) {
    return choice.explicit
      ? { kind: "setClaude", instances: [choice.instanceId], value: null }
      : null;
  }
  return picked === choice.value
    ? null
    : { kind: "setClaude", instances: [choice.instanceId], value: picked };
}

// -- Subfolders ---------------------------------------------------------------------------------

export type NestedFile = { readonly id: string; readonly folder: string; readonly file: string };

/** The AGENTS.md and CLAUDE.md files in the project's subfolders, by folder. */
export function nestedFiles(entries: readonly InstructionEntry[]): NestedFile[] {
  return entries
    .filter((entry) => entry.kind === "nested" && entry.exists)
    .map((entry) => ({ id: entry.id, ...splitNested(entry) }))
    .sort(
      (a, b) =>
        a.folder.localeCompare(b.folder, undefined, { numeric: true, sensitivity: "base" }) ||
        a.file.localeCompare(b.file),
    );
}

// -- An open file -------------------------------------------------------------------------------

export type InstructionChip = {
  readonly agent: SkillAgent;
  readonly on: boolean;
  /** The agent can't be switched here. */
  readonly locked: boolean;
  /** What a click does; null when it does nothing. */
  readonly plan: InstructionPlan | null;
  /** The tooltip, one line each. */
  readonly lines: readonly string[];
};

function claudeSettingChip(
  agent: SkillAgent,
  access: InstructionAgentAccess,
  choice: ClaudeInstructionChoice | undefined,
  ctx: SkillsContext,
): InstructionChip {
  const name = agent.displayName;
  const instances = [agent.instanceId];
  if (access.state === "import") {
    return {
      agent,
      on: true,
      locked: true,
      plan: null,
      lines: [`${name} reads it through the project's CLAUDE.md.`],
    };
  }
  if (choice?.value === "managed-only") {
    return {
      agent,
      on: access.state !== "none",
      locked: true,
      plan: null,
      lines: ["Your organization decides this."],
    };
  }
  if (access.state === "setting") {
    return {
      agent,
      on: true,
      locked: false,
      plan: planClaudeNever(instances, ctx),
      lines: [`${name} reads it in every project.`],
    };
  }
  if (access.reason === "oldVersion") {
    return {
      agent,
      on: false,
      locked: true,
      plan: null,
      lines: [`Needs Claude Code ${CLAUDE_SETTING_VERSION} or later.`],
    };
  }
  return {
    agent,
    on: false,
    locked: false,
    plan: planClaudeAgents(instances, ctx),
    lines: [
      access.reason === "claudeFiles"
        ? `${name} skips it because of ${access.blockingFile ?? "CLAUDE.md"}.`
        : `${name} doesn't read AGENTS.md.`,
    ],
  };
}

/** The agents under "Used by", each with what clicking it does. */
export function instructionChips(
  entry: InstructionEntry,
  ctx: SkillsContext,
  data: Pick<InstructionData, "entries" | "claude">,
): InstructionChip[] {
  return listedAgents(entry, ctx).map((agent): InstructionChip => {
    const access = accessFor(entry, agent)!;
    const name = agent.displayName;
    if (access.state === "direct") {
      return {
        agent,
        on: true,
        locked: true,
        plan: null,
        lines: ["Always on. It reads this file directly."],
      };
    }
    if (isProjectAgentsFile(entry) && isClaude(agent)) {
      return claudeSettingChip(
        agent,
        access,
        data.claude.find((choice) => choice.instanceId === agent.instanceId),
        ctx,
      );
    }
    const on = access.state !== "none";
    if (isGlobalFile(entry) && !entry.readOnly) {
      if (on) {
        return {
          agent,
          on,
          locked: false,
          plan: enablePlan(entry.id, "disable", [agent]),
          lines: [
            access.state === "import"
              ? `${name} imports this file from its own CLAUDE.md.`
              : `${name} reads a link to this file.`,
          ],
        };
      }
      if (access.reason === "ownFile") {
        const own = ownGlobalFile(agent, data.entries);
        return {
          agent,
          on,
          locked: own === undefined,
          plan: own ? planAdopt([{ entry: own, name }]) : null,
          lines: [`${name} has its own instructions.`],
        };
      }
      if (access.reason === "oldVersion") {
        return { agent, on, locked: true, plan: null, lines: [`${name} is too old to read it.`] };
      }
      return {
        agent,
        on,
        locked: false,
        plan: enablePlan(entry.id, "enable", [agent]),
        lines: [`${name} doesn't use this file.`],
      };
    }
    return {
      agent,
      on,
      locked: true,
      plan: null,
      lines: [on ? `${name} reads this file.` : `${name} doesn't read this file.`],
    };
  });
}

export type InstructionActions = {
  readonly turnOnAll: InstructionPlan | null;
  readonly removeFromAgents: InstructionPlan | null;
  /** Move the project's CLAUDE.md to AGENTS.md, or merge it into the one that is there. */
  readonly share: InstructionFix | null;
  readonly useGlobal: InstructionPlan | null;
  readonly remove: InstructionPlan | null;
};

/** What a delete calls the file: its title, which is its name, or for a subfolder file its path. */
const deleteName = (row: InstructionRow) =>
  row.entry.kind === "nested" ? entryFileName(row.entry) : row.title;

/** What the ⋯ menu of an open file can do. */
export function instructionActions(
  row: InstructionRow,
  ctx: SkillsContext,
  data: Pick<InstructionData, "entries" | "claude">,
): InstructionActions {
  const { entry } = row;
  const editable = entry.exists && !entry.readOnly;
  const isGlobal = isGlobalFile(entry);
  const turnOn = isGlobal && editable ? switchableAgents(entry, ctx) : [];
  const linked =
    isGlobal && editable
      ? listedAgents(entry, ctx).filter((agent) => {
          const state = accessFor(entry, agent)?.state;
          return state === "link" || state === "import";
        })
      : [];
  const owner = entry.owner === undefined ? undefined : agentOf(ctx, entry.owner);
  return {
    turnOnAll: turnOn.length > 0 ? enablePlan(entry.id, "enable", turnOn) : null,
    removeFromAgents: linked.length > 0 ? planRemove(entry, linked) : null,
    share: editable && isProjectClaudeFile(entry) ? shareFix(entry, ctx, data) : null,
    useGlobal:
      editable && entry.scope === "global" && entry.kind === "agentOwn" && owner
        ? planAdopt([{ entry, name: owner.displayName }])
        : null,
    remove:
      editable && entry.kind !== "shared" && entry.kind !== "managed"
        ? planDelete(entry, deleteName(row), ctx, data)
        : null,
  };
}

// -- Search and the list ------------------------------------------------------------------------

/** A file matches by its title, its file name such as "agents.md", and its group or folder. */
export const matchesInstructionQuery = (row: InstructionRow, needle: string) =>
  `${row.title} ${entryFileName(row.entry)} ${row.headingNote}`.toLowerCase().includes(needle);

export const matchesClaudeQuery = (row: ClaudeRow, needle: string) =>
  `${row.title} ${row.agent.displayName} claude agents.md`.toLowerCase().includes(needle);

const matchesNestedQuery = (file: NestedFile, needle: string) =>
  `${file.folder}/${file.file}`.toLowerCase().includes(needle);

/** Files that need a look, whatever the search and filter show. */
export const instructionAttentionCount = (
  data: Pick<InstructionData, "entries" | "claude">,
  ctx: SkillsContext,
) => instructionRows(data, ctx).filter((row) => row.attention !== null).length;

/** What the Instructions card shows, in order. */
export type InstructionItem =
  | { readonly kind: "group"; readonly group: InstructionGroup; readonly label: string }
  | { readonly kind: "file"; readonly row: InstructionRow }
  | { readonly kind: "subfolders"; readonly files: readonly NestedFile[] }
  | { readonly kind: "claude"; readonly row: ClaudeRow };

/**
 * The card's items for a search and the Needs attention filter, under a Project and a Global
 * heading. Project holds its files and the subfolder files folded into one item; Global holds its
 * files, then Claude's choice. A heading is only there when something is under it. A search
 * narrows the subfolder files too; the filter leaves out what can't need attention.
 */
export function instructionItems(
  data: Pick<InstructionData, "entries" | "claude">,
  ctx: SkillsContext,
  view: { readonly needle: string; readonly onlyAttention: boolean },
): InstructionItem[] {
  const { needle, onlyAttention } = view;
  const rows = instructionRows(data, ctx).filter(
    (row) => (!onlyAttention || row.attention !== null) && matchesInstructionQuery(row, needle),
  );
  const subfolders = onlyAttention
    ? []
    : nestedFiles(data.entries).filter((file) => needle === "" || matchesNestedQuery(file, needle));
  const claude = onlyAttention
    ? []
    : claudeRows(data.claude, ctx).filter((row) => matchesClaudeQuery(row, needle));
  const files = (group: InstructionGroup) =>
    rows
      .filter((row) => row.group === group)
      .map((row): InstructionItem => ({ kind: "file", row }));
  const under = (group: InstructionGroup, items: readonly InstructionItem[]): InstructionItem[] =>
    items.length === 0 ? [] : [{ kind: "group", group, label: GROUP_LABEL[group] }, ...items];
  return [
    ...under("project", [
      ...files("project"),
      ...(subfolders.length > 0 ? [{ kind: "subfolders" as const, files: subfolders }] : []),
    ]),
    ...under("global", [
      ...files("global"),
      ...claude.map((row): InstructionItem => ({ kind: "claude", row })),
    ]),
  ];
}

// -- Saying what happened -----------------------------------------------------------------------

/** One short line on the files the server couldn't read, which would otherwise look empty. */
export function instructionUnreadableNote(files: InstructionListResult["unreadable"]) {
  const [first, second, ...rest] = files.map((item) => item.path);
  if (first === undefined) return "";
  if (second === undefined) return `Couldn't read ${first}`;
  return rest.length === 0
    ? `Couldn't read ${first} and ${second}`
    : `Couldn't read ${first}, ${second} and ${rest.length} more`;
}

type Reason = InstructionError["reason"];

/** The reason the server gave for refusing, or null for any other failure. */
export function instructionErrorReason(error: unknown): Reason | null {
  if (typeof error !== "object" || error === null) return null;
  const { _tag, reason } = error as { _tag?: unknown; reason?: unknown };
  return _tag === "InstructionError" && typeof reason === "string" ? (reason as Reason) : null;
}

/** The file changed under an edit, so saving would overwrite someone else's work. */
export const isSaveConflict = (reason: Reason | null) =>
  reason === "changedOnDisk" || reason === "exists";

const REASON_TEXT: Record<Reason, string> = {
  changedOnDisk: "That file changed since the list was read.",
  exists: "A file with that name is already there.",
  notFound: "That file isn't there any more.",
  readOnly: "That file is read-only.",
  tooLarge: "That file is too large.",
  unknownEntry: "That file isn't in the list any more.",
  unregisteredProject: "This project isn't set up in T3 Code.",
  invalidSettings: "Claude's settings file isn't valid JSON, so T3 Code left it alone.",
  linkFailed: "Couldn't make the link. On Windows, turn on Developer Mode.",
  writeFailed: "Couldn't change that file.",
};

export const CHANGE_FAILED = "Couldn't change the instructions here.";

export const failureText = (reason: Reason | null) =>
  reason === null ? CHANGE_FAILED : REASON_TEXT[reason];

/** One status line on what a change did to the agents, from what the server says happened. */
export function describeAgentsResult(
  kind: "enable" | "disable",
  results: InstructionAgentsResult["results"],
  ctx: SkillsContext,
) {
  const nameOf = (id: ProviderInstanceId) => agentOf(ctx, id)?.displayName ?? id;
  const changed = results.filter((result) => result.outcome === "changed");
  const failed = results.filter((result) => result.outcome === "failed");
  const lead =
    changed.length === 0
      ? ""
      : `${kind === "enable" ? "Turned on" : "Turned off"} for ${joinNames(changed.map((result) => nameOf(result.instanceId)))}.`;
  const problems = failed.map((result) =>
    result.reason
      ? `Couldn't change ${nameOf(result.instanceId)}: ${result.reason}`
      : `Couldn't change ${nameOf(result.instanceId)}.`,
  );
  if (lead === "" && problems.length === 0) {
    return kind === "enable" ? "Already on." : "Already off.";
  }
  return [lead, ...problems].filter((part) => part !== "").join(" ");
}

/** One status line for a change that has no per-agent outcome. */
export function describeChange(change: InstructionChange, ctx: SkillsContext): string {
  switch (change.kind) {
    case "setClaude": {
      const names = claudeNames(change.instances, ctx);
      const many = change.instances.length > 1;
      if (change.value === "claude-md-and-agents-md") {
        return `${names} now ${many ? "read" : "reads"} AGENTS.md in every project.`;
      }
      if (change.value === "claude-md") {
        return `${names} no longer ${many ? "read" : "reads"} AGENTS.md.`;
      }
      return `${names} ${many ? "follow" : "follows"} ${many ? "their" : "its"} default again.`;
    }
    case "adopt":
      return `${joinNames(change.names)} now ${change.names.length > 1 ? "use" : "uses"} your Global instructions.`;
    case "share": {
      const lead = change.merge
        ? "Merged CLAUDE.md into AGENTS.md."
        : "CLAUDE.md is now AGENTS.md.";
      return change.claude.length === 0
        ? lead
        : `${lead} ${describeChange({ kind: "setClaude", instances: change.claude, value: "claude-md-and-agents-md" }, ctx)}`;
    }
    case "delete":
      return `Deleted ${change.name}.`;
    case "enable":
    case "disable":
      return "";
  }
}
