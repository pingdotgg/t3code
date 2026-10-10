import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type {
  ServerProvider,
  SkillAgentAccess,
  SkillListResult,
  SkillOutcome,
} from "@t3tools/contracts";

import {
  attention,
  availability,
  availabilityNote,
  checkState,
  compareSkillFiles,
  describeResult,
  groupAvailability,
  groupBySource,
  ingestSkills,
  installedAgents,
  listSwitchOn,
  matchesQuery,
  placeTarget,
  planDelete,
  planFix,
  planListSwitch,
  planPlace,
  planRowSwitch,
  planToggle,
  planTurnOff,
  planTurnOffAll,
  planTurnOnAll,
  projectsBadge,
  rowSwitchOn,
  scriptFiles,
  sendInBatches,
  skillBody,
  skillsEnvironment,
  skillsToCheckWithGit,
  startingPlacement,
  switchBlocker,
  unreadableNote,
  withGitNote,
  type PlaceTarget,
  type ProjectOption,
  type Skill,
  type SkillAgent,
} from "./SkillsSettings.logic";

const agent = (instanceId: string, driver: string, displayName: string): SkillAgent => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driverKind: ProviderDriverKind.make(driver),
  displayName,
  accentColor: undefined,
});
const claude = agent("claudeAgent", "claudeAgent", "Claude");
const codex = agent("codex", "codex", "Codex");
const claudeWork = agent("claude_work", "claudeAgent", "Claude Work");
const ALL = [claude, codex, agent("cursor", "cursor", "Cursor")];

/** A skill the way the server reports it; `reach` says how each listed agent gets to it. */
function skill(
  name: string,
  reach: Partial<Record<string, SkillAgentAccess["state"]>> = {},
  extra: Partial<Skill> = {},
): Skill {
  const scope = extra.scope ?? "project";
  return {
    id: `${scope}\0${name}`,
    name,
    scope,
    home: scope === "global" ? `~/.agents/skills/${name}` : `.agents/skills/${name}`,
    description: `The ${name} skill.`,
    copies: [],
    access: [...ALL, claudeWork].map((entry) => ({
      instanceId: entry.instanceId,
      driver: entry.driverKind,
      state: reach[entry.instanceId] ?? "none",
      folder: scope === "global" ? "~/.agents/skills" : ".agents/skills",
    })),
    ...extra,
  };
}

const provider = (
  instanceId: string,
  driver: string,
  over: Partial<
    Pick<ServerProvider, "installed" | "enabled" | "availability" | "displayName">
  > = {},
) =>
  ({
    instanceId,
    driver,
    installed: true,
    enabled: true,
    status: "ready",
    models: [],
    skills: [],
    ...over,
  }) as unknown as ServerProvider;

describe("ingestSkills", () => {
  it("gives every skill home its own id and lists the instances the server knows", () => {
    const result: SkillListResult = {
      skills: [
        skill("tdd", { codex: "direct" }),
        skill("tdd", { codex: "direct" }, { home: ".claude/skills/tdd" }),
        skill("tdd", { codex: "direct" }, { scope: "global" }),
      ],
      unreadable: [{ scope: "global", folder: "~/.claude/skills" }],
    };
    const { skills, known, unreadable } = ingestSkills(result);
    expect(new Set(skills.map((item) => item.id)).size).toBe(3);
    expect([...known].toSorted()).toEqual(["claudeAgent", "claude_work", "codex", "cursor"]);
    expect(unreadable).toEqual([{ scope: "global", folder: "~/.claude/skills" }]);
  });
});

describe("skillsEnvironment", () => {
  const home = { environmentId: EnvironmentId.make("home") };
  const work = { environmentId: EnvironmentId.make("work") };
  const all = [home, work];

  it("uses the scope's connected environment", () => {
    expect(
      skillsEnvironment({
        connected: work,
        scopeEnvironmentIds: [work.environmentId],
        environments: all,
        primaryId: home.environmentId,
      }),
    ).toBe(work);
  });

  it("keeps an offline scoped environment instead of showing the primary one's skills", () => {
    expect(
      skillsEnvironment({
        connected: null,
        scopeEnvironmentIds: [work.environmentId],
        environments: all,
        primaryId: home.environmentId,
      }),
    ).toBe(work);
  });

  it("has no environment when the scope names one that is gone", () => {
    expect(
      skillsEnvironment({
        connected: null,
        scopeEnvironmentIds: [EnvironmentId.make("gone")],
        environments: all,
        primaryId: home.environmentId,
      }),
    ).toBeUndefined();
  });

  it("falls back to the primary, then the first, when the scope names no environment", () => {
    const fallback = { connected: null, scopeEnvironmentIds: [], environments: all };
    expect(skillsEnvironment({ ...fallback, primaryId: work.environmentId })).toBe(work);
    expect(skillsEnvironment({ ...fallback, primaryId: null })).toBe(home);
    expect(skillsEnvironment({ ...fallback, environments: [], primaryId: null })).toBeUndefined();
  });
});

describe("installedAgents", () => {
  const known = new Set(
    ["claudeAgent", "claude_work", "codex", "cursor", "pi", "opencode"].map((id) =>
      ProviderInstanceId.make(id),
    ),
  );

  it("keeps instances that are installed, enabled and reachable, each with its own name", () => {
    expect(
      installedAgents(
        [
          provider("claudeAgent", "claudeAgent", { displayName: "Claude" }),
          provider("claude_work", "claudeAgent", { displayName: "Claude Work" }),
          provider("codex", "codex", { installed: false }),
          provider("pi", "pi", { enabled: false }),
          provider("opencode", "opencode", { availability: "unavailable" }),
          provider("cursor", "cursor"),
        ],
        known,
      ).map((item) => [item.instanceId, item.displayName]),
    ).toEqual([
      ["claudeAgent", "Claude"],
      ["claude_work", "Claude Work"],
      ["cursor", "Cursor"],
    ]);
  });

  it("leaves out instances the server has no folders for", () => {
    expect(
      installedAgents(
        [provider("claudeAgent", "claudeAgent"), provider("codex", "codex")],
        new Set([ProviderInstanceId.make("claudeAgent")]),
      ).map((item) => item.instanceId),
    ).toEqual(["claudeAgent"]);
  });
});

describe("who can use a skill", () => {
  const ctx = { installed: [claude, codex] };

  it("shows one mark when every installed agent can, whatever the others do", () => {
    const value = availability(skill("a", { claudeAgent: "link", codex: "direct" }), ctx);
    expect(value).toMatchObject({ everyone: true, missing: [] });
    expect(value.agents).toEqual([claude, codex]);
    expect(availabilityNote(value)).toBe("Available to all your agents");
  });

  it("names the agents that can't", () => {
    const value = availability(skill("a", { codex: "direct" }), ctx);
    expect(value).toMatchObject({ everyone: false, agents: [codex], missing: [claude] });
    expect(availabilityNote(value)).toBe("Not available to Claude");
  });

  it("tells two instances of one agent apart by their names", () => {
    const both = { installed: [claude, claudeWork] };
    const value = availability(skill("a", { claude_work: "direct" }), both);
    expect(value.agents).toEqual([claudeWork]);
    expect(availabilityNote(value)).toBe("Not available to Claude");
    expect(availabilityNote(availability(skill("a"), both))).toBe(
      "Not available to Claude and Claude Work",
    );
  });

  it("is never everyone when no agent is installed", () => {
    const value = availability(skill("a", { codex: "direct" }), { installed: [] });
    expect(value).toMatchObject({ everyone: false, agents: [], missing: [] });
  });
});

describe("attention", () => {
  const ctx = { installed: [claude, codex] };
  const both = { claudeAgent: "link", codex: "direct" } as const;

  it("flags a skill that differs from a copy in the other scope, and names that scope", () => {
    const different = [{ scope: "global", home: "~/.agents/skills/tdd", same: false }] as const;
    expect(attention(skill("tdd", both, { copies: different }), ctx)).toEqual({
      kind: "conflict",
      detail: "Global has a different “tdd”.",
    });
    expect(
      attention(
        skill("tdd", both, {
          scope: "global",
          copies: [{ scope: "project", home: ".agents/skills/tdd", same: false }],
        }),
        ctx,
      ),
    ).toEqual({ kind: "conflict", detail: "This project has a different “tdd”." });
  });

  it("flags a copy that differs from another one in the same scope", () => {
    expect(
      attention(
        skill("tdd", both, {
          copies: [{ scope: "project", home: ".claude/skills/tdd", same: false }],
        }),
        ctx,
      )?.detail,
    ).toBe("Another “tdd” in this project is different.");
    expect(
      attention(
        skill("tdd", both, {
          scope: "global",
          copies: [{ scope: "global", home: "~/.claude/skills/tdd", same: false }],
        }),
        ctx,
      )?.detail,
    ).toBe("Another global “tdd” is different.");
  });

  it("doesn't flag an identical copy", () => {
    const same = [{ scope: "global", home: "~/.agents/skills/tdd", same: true }] as const;
    expect(attention(skill("tdd", both, { copies: same }), ctx)).toBeNull();
  });

  it("flags a skill an installed agent can't use, and says which", () => {
    expect(attention(skill("a", { codex: "direct" }), ctx)).toEqual({
      kind: "missing",
      detail: "Not available to Claude",
    });
    expect(attention(skill("a", both), ctx)).toBeNull();
  });

  it("says plainly when Claude can't read the header", () => {
    expect(attention(skill("a", { codex: "direct" }, { invalidHeader: true }), ctx)).toEqual({
      kind: "header",
      detail: "Claude can't read this skill's header.",
    });
    // Without Claude there is nothing to report about its header.
    expect(
      attention(skill("a", { codex: "direct" }, { invalidHeader: true }), { installed: [codex] }),
    ).toBeNull();
  });

  it("ignores agents that aren't installed, and puts a conflict first", () => {
    expect(attention(skill("a", { codex: "direct" }), { installed: [codex] })).toBeNull();
    const conflicting = skill(
      "a",
      {},
      { copies: [{ scope: "global", home: "~/.agents/skills/a", same: false }] },
    );
    expect(attention(conflicting, ctx)?.kind).toBe("conflict");
  });
});

describe("unreadableNote", () => {
  const folder = (name: string) => ({ scope: "global" as const, folder: name });

  it("names the folders that couldn't be read, briefly", () => {
    expect(unreadableNote([])).toBe("");
    expect(unreadableNote([folder("~/.claude/skills")])).toBe("Couldn't read ~/.claude/skills");
    expect(unreadableNote([folder("~/.claude/skills"), folder(".pi/skills")])).toBe(
      "Couldn't read ~/.claude/skills and .pi/skills",
    );
    expect(unreadableNote(["a", "b", "c", "d"].map(folder))).toBe("Couldn't read a, b and 2 more");
  });
});

describe("search", () => {
  it("matches the name and the description", () => {
    const item = skill("verify", {}, { description: "Drive the app" });
    expect(matchesQuery(item, "verif")).toBe(true);
    expect(matchesQuery(item, "drive")).toBe(true);
    expect(matchesQuery(item, "nope")).toBe(false);
    expect(matchesQuery(item, "")).toBe(true);
  });
});

describe("a skill's files", () => {
  it("calls files an agent could run scripts, but never SKILL.md", () => {
    expect(
      scriptFiles([
        { path: "SKILL.md", executable: true },
        { path: "bin/run", executable: false },
        { path: "lib/serve.mjs", executable: false },
        { path: "refs/notes.md", executable: false },
        { path: "tools/check", executable: true },
      ]),
    ).toEqual(["bin/run", "lib/serve.mjs", "tools/check"]);
  });

  it("sorts SKILL.md first, then folders before files, with numbers in order", () => {
    const entry = (path: string, isDirectory = false) => ({
      path,
      isDirectory,
      segments: path.replace(/\/$/, "").split("/"),
    });
    const sorted = [
      entry("refs/note-10.md"),
      entry("README.md"),
      entry("SKILL.md"),
      entry("refs/note-2.md"),
      entry("refs/", true),
      entry("a.txt"),
    ].toSorted(compareSkillFiles);
    expect(sorted.map((item) => item.path)).toEqual([
      "SKILL.md",
      "refs/",
      "refs/note-2.md",
      "refs/note-10.md",
      "a.txt",
      "README.md",
    ]);
  });

  it("drops the header and the blank lines after it from the rendered text", () => {
    expect(skillBody("---\nname: a\n---\n\n\n# Title\n")).toBe("# Title\n");
    expect(skillBody("---\r\nname: a\r\n---\r\n# Title\r\n")).toBe("# Title\r\n");
    expect(skillBody("# No header\n")).toBe("# No header\n");
  });
});

// -- Turning skills on and off --------------------------------------------------------------------

/** A skill whose agents each read it from their own folder, the way the server reports links. */
function reached(
  name: string,
  access: Record<string, { state: SkillAgentAccess["state"]; folder: string; fixed?: boolean }>,
  home = `~/library/skills/${name}`,
): Skill {
  return {
    ...skill(name, {}, { scope: "global", home }),
    access: Object.entries(access).map(([instanceId, { state, folder, fixed }]) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make(instanceId),
      state,
      folder,
      ...(fixed ? { fixed } : {}),
    })),
  };
}
const ref = (name: string, home = `~/library/skills/${name}`) => ({
  scope: "global" as const,
  name,
  home,
});
const ctx = { installed: ALL };
const outcome = (over: Partial<SkillOutcome> & { name: string }): SkillOutcome => ({
  skill: ref(over.name),
  status: "changed",
  blocked: [],
  affected: [],
  ...over,
});

describe("an agent's switch", () => {
  it("is locked only when T3 Code can't switch the agent, whatever way it reaches the skill", () => {
    const tdd = reached("tdd", {
      claudeAgent: { state: "direct", folder: "~/.claude/skills" },
      codex: { state: "link", folder: "~/.codex/skills" },
      cursor: { state: "direct", folder: "~/.agents/skills", fixed: true },
    });
    expect(switchBlocker(tdd, claude)).toBeNull();
    expect(switchBlocker(tdd, codex)).toBeNull();
    expect(switchBlocker(tdd, ALL[2]!)).toBe("Always on. Cursor reads this folder directly.");
    expect(
      switchBlocker(
        reached("x", { cursor: { state: "none", folder: "~/.cursor/skills", fixed: true } }),
        ALL[2]!,
      ),
    ).toBe("Cursor can't be switched for this skill.");
  });

  it("turns on for the agent that was clicked, and off for one that has it", () => {
    const tdd = reached("tdd", {
      claudeAgent: { state: "none", folder: "~/.claude/skills" },
      codex: { state: "link", folder: "~/.codex/skills" },
    });
    expect(planToggle(tdd, claude, ctx)).toEqual({
      change: { kind: "enable", skills: [ref("tdd")], agents: ["claudeAgent"] },
      affected: 1,
    });
    expect(planToggle(tdd, codex, ctx)?.change).toEqual({
      kind: "disable",
      skills: [ref("tdd")],
      agents: ["codex"],
    });
  });
});

describe("turning on for all agents", () => {
  const cursor = ALL[2]!;
  it("asks for the agents that some selected skill is missing, and never asks first", () => {
    const first = reached("first", {
      claudeAgent: { state: "direct", folder: "~/.claude/skills" },
      codex: { state: "none", folder: "~/.agents/skills" },
      cursor: { state: "direct", folder: "~/.agents/skills" },
    });
    const second = reached("second", {
      claudeAgent: { state: "none", folder: "~/.claude/skills" },
      codex: { state: "direct", folder: "~/.agents/skills" },
      cursor: { state: "direct", folder: "~/.agents/skills" },
    });
    const done = reached("done", {
      claudeAgent: { state: "link", folder: "~/.claude/skills" },
      codex: { state: "direct", folder: "~/.agents/skills" },
      cursor: { state: "direct", folder: "~/.agents/skills" },
    });

    const plan = planTurnOnAll([first, second, done], ctx);

    expect(plan?.change).toEqual({
      kind: "enable",
      skills: [ref("first"), ref("second")],
      agents: ["claudeAgent", "codex"],
    });
    expect(plan?.affected).toBe(2);
    expect(plan?.confirmation).toBeUndefined();
    expect(planTurnOnAll([done], ctx)).toBeNull();
  });

  it("leaves out agents that aren't installed", () => {
    const tdd = reached("tdd", {
      claudeAgent: { state: "direct", folder: "~/.claude/skills" },
      codex: { state: "none", folder: "~/.agents/skills" },
      cursor: { state: "none", folder: "~/.cursor/skills" },
    });
    expect(planTurnOnAll([tdd], { installed: [claude, cursor] })?.change).toMatchObject({
      agents: ["cursor"],
    });
  });

  it("gives one skill the same one-click fix, naming the agent when only one is missing", () => {
    const some = reached("tdd", {
      claudeAgent: { state: "none", folder: "~/.claude/skills" },
      codex: { state: "direct", folder: "~/.agents/skills" },
      cursor: { state: "direct", folder: "~/.agents/skills" },
    });
    const most = reached("tdd", {
      claudeAgent: { state: "none", folder: "~/.claude/skills" },
      codex: { state: "none", folder: "~/.agents/skills" },
      cursor: { state: "direct", folder: "~/.agents/skills" },
    });
    expect(planFix(some, ctx)?.label).toBe("Turn on for Claude");
    expect(planFix(most, ctx)?.label).toBe("Turn on for all agents");
    expect(planFix(most, ctx)?.plan.change).toMatchObject({ agents: ["claudeAgent", "codex"] });
    expect(
      planFix(reached("ok", { claudeAgent: { state: "link", folder: "~/.claude/skills" } }), {
        installed: [claude],
      }),
    ).toBeNull();
  });
});

describe("one switch for every agent", () => {
  const cursor = ALL[2]!;
  const on = (name: string, extra: Record<string, boolean> = {}) =>
    reached(name, {
      claudeAgent: { state: "link", folder: "~/.claude/skills" },
      codex: { state: "direct", folder: "~/.agents/skills" },
      cursor: {
        state: "direct",
        folder: "~/.agents/skills",
        ...(extra.fixed ? { fixed: true } : {}),
      },
    });
  const off = (name: string) =>
    reached(name, {
      claudeAgent: { state: "none", folder: "~/.claude/skills" },
      codex: { state: "off", folder: "~/.agents/skills" },
      cursor: { state: "none", folder: "~/.cursor/skills" },
    });
  const some = (name: string) =>
    reached(name, {
      claudeAgent: { state: "link", folder: "~/.claude/skills" },
      codex: { state: "off", folder: "~/.agents/skills" },
      cursor: { state: "none", folder: "~/.cursor/skills" },
    });

  it("is on when any agent uses the skill, and an agent switched off in its settings doesn't", () => {
    expect(rowSwitchOn(on("a"), ctx)).toBe(true);
    expect(rowSwitchOn(some("a"), ctx)).toBe(true);
    expect(rowSwitchOn(off("a"), ctx)).toBe(false);
    expect(rowSwitchOn(on("a"), { installed: [] })).toBe(false);
  });

  it("turns a skill on for every agent that lacks it, and off for every agent that has it", () => {
    expect(planRowSwitch(off("a"), ctx)).toEqual({
      change: {
        kind: "enable",
        skills: [ref("a")],
        agents: ["claudeAgent", "codex", "cursor"],
      },
      affected: 1,
    });
    // A skill that is on for some agents has its switch on, so flipping it turns it off.
    const turnOff = planRowSwitch(some("a"), ctx);
    expect(turnOff?.change).toEqual({
      kind: "disable",
      skills: [ref("a")],
      agents: ["claudeAgent"],
    });
    expect(turnOff?.confirmation).toBeUndefined();
  });

  it("asks an agent T3 Code can't switch too when turning off, so the result can say why it stays", () => {
    const plan = planRowSwitch(on("a", { fixed: true }), ctx);
    expect(plan?.change).toMatchObject({
      kind: "disable",
      agents: ["claudeAgent", "codex", "cursor"],
    });
    expect(plan?.confirmation).toBeUndefined();
    // And never asks to turn on an agent that can't be switched.
    const stuck = reached("b", {
      claudeAgent: { state: "link", folder: "~/.claude/skills" },
      codex: { state: "link", folder: "~/.codex/skills" },
      cursor: { state: "none", folder: "~/.cursor/skills", fixed: true },
    });
    expect(planTurnOnAll([stuck], ctx)).toBeNull();
  });

  it("is a section's switch exactly when every row switch in it is on", () => {
    expect(listSwitchOn([on("a"), on("b")], ctx)).toBe(true);
    // A row on for only some agents has its switch on, so the section's switch follows.
    expect(listSwitchOn([on("a"), some("b")], ctx)).toBe(true);
    expect(listSwitchOn([on("a"), off("b")], ctx)).toBe(false);
    expect(listSwitchOn([], ctx)).toBe(false);
    expect(listSwitchOn([on("a")], { installed: [] })).toBe(false);
  });

  it("turns a whole section on for all agents without asking", () => {
    const plan = planListSwitch([some("a"), off("b"), on("c")], ctx);
    expect(plan?.change).toEqual({
      kind: "enable",
      skills: [ref("a"), ref("b")],
      agents: ["claudeAgent", "codex", "cursor"],
    });
    expect(plan?.confirmation).toBeUndefined();
  });

  it("fills in the agents that are off on rows that are already on when turning a section on", () => {
    const plan = planListSwitch([some("a"), off("b")], ctx);
    expect(plan?.change).toEqual({
      kind: "enable",
      skills: [ref("a"), ref("b")],
      agents: ["claudeAgent", "codex", "cursor"],
    });
  });

  it("turns a section off for every agent when its rows are all on, even for only some agents", () => {
    const plan = planListSwitch([on("a"), some("b")], ctx);
    expect(plan?.change).toMatchObject({ kind: "disable", skills: [ref("a"), ref("b")] });
    expect(plan?.confirmation?.title).toBe("Turn off 2 skills for every agent?");
  });

  it("asks before turning a whole section off, and says what stays on", () => {
    const plan = planListSwitch([on("a"), on("b", { fixed: true })], ctx);
    expect(plan?.change).toEqual({
      kind: "disable",
      skills: [ref("a"), ref("b")],
      agents: ["claudeAgent", "codex", "cursor"],
    });
    expect(plan?.affected).toBe(2);
    expect(plan?.confirmation).toEqual({
      title: "Turn off 2 skills for every agent?",
      body: "",
      notes: ["1 skill stays on because Cursor reads its folder."],
      confirm: "Turn off",
      destructive: false,
    });
    expect(planListSwitch([on("only")], ctx)?.confirmation?.title).toBe(
      "Turn off “only” for every agent?",
    );
  });

  it("turns the selected skills off for every agent, asking only when asked to", () => {
    expect(planTurnOffAll([off("a")], ctx, { ask: true })).toBeNull();
    expect(planTurnOffAll([on("a"), on("b")], ctx, { ask: false })?.confirmation).toBeUndefined();
    expect(planTurnOffAll([on("a"), on("b")], ctx, { ask: true })?.confirmation?.title).toBe(
      "Turn off 2 skills for every agent?",
    );
    expect(
      planTurnOffAll([on("a")], { installed: [cursor] }, { ask: false })?.change,
    ).toMatchObject({
      agents: ["cursor"],
    });
  });
});

describe("selecting rows", () => {
  it("ticks a group's box when all its skills are ticked, and half-ticks it when some are", () => {
    const ids = ["a", "b", "c"];
    expect(checkState(ids, new Set())).toEqual({ checked: false, indeterminate: false });
    expect(checkState(ids, new Set(["b"]))).toEqual({ checked: false, indeterminate: true });
    expect(checkState(ids, new Set(["a", "b", "c", "other"]))).toEqual({
      checked: true,
      indeterminate: false,
    });
    expect(checkState([], new Set(["a"]))).toEqual({ checked: false, indeterminate: false });
  });
});

describe("grouping by where skills came from", () => {
  const from = (name: string, source?: string) => skill(name, {}, source ? { source } : {});

  it("groups skills that share a source when there are two or more, by name", () => {
    const { groups, loose } = groupBySource([
      from("tdd", "mattpocock/skills"),
      from("solo", "acme/one-off"),
      from("mine"),
      from("grill", "mattpocock/skills"),
      from("db", "acme/tools"),
      from("api", "acme/tools"),
    ]);
    expect(groups.map((group) => [group.source, group.skills.map((item) => item.name)])).toEqual([
      ["acme/tools", ["db", "api"]],
      ["mattpocock/skills", ["tdd", "grill"]],
    ]);
    // One skill from a source isn't a group, and neither is one with no source.
    expect(loose.map((item) => item.name)).toEqual(["solo", "mine"]);
  });

  it("has no groups when nothing shares a source", () => {
    const { groups, loose } = groupBySource([from("a", "x/y"), from("b")]);
    expect(groups).toEqual([]);
    expect(loose).toHaveLength(2);
  });

  it("shows the agents that have every skill in the group on", () => {
    const both = { installed: [claude, codex] };
    const a = skill("a", { claudeAgent: "link", codex: "direct" });
    const b = skill("b", { claudeAgent: "link" });
    expect(groupAvailability([a, b], both)).toMatchObject({
      everyone: false,
      agents: [claude],
      missing: [codex],
    });
    expect(groupAvailability([a, a], both).everyone).toBe(true);
  });
});

describe("turning off for one agent", () => {
  const workCodex = agent("codex_work", "codex", "Codex Work");
  const both = { installed: [codex, workCodex, claude] };
  const linked = (name: string, ...others: Array<[string, "link" | "direct" | "none"]>) =>
    reached(name, {
      codex: { state: "link", folder: "~/.codex/skills" },
      codex_work: { state: "link", folder: "~/.codex/skills" },
      claudeAgent: { state: "none", folder: "~/.claude/skills" },
      ...Object.fromEntries(
        others.map(([id, state]) => [id, { state, folder: "~/.claude/skills" }]),
      ),
    });

  it("asks first when another agent reads the same link and loses the skill too", () => {
    const plan = planTurnOff([linked("tdd"), linked("grill")], codex, both);

    expect(plan?.change).toEqual({
      kind: "disable",
      skills: [ref("tdd"), ref("grill")],
      agents: ["codex"],
    });
    expect(plan?.confirmation).toEqual({
      title: "Turn off for Codex?",
      body: "Removes Codex's link for 2 skills.",
      notes: ["Codex Work loses these too."],
      confirm: "Turn off",
      destructive: false,
    });
  });

  it("goes ahead without asking when nothing else is lost", () => {
    const alone = reached("tdd", {
      codex: { state: "link", folder: "~/.codex/skills" },
      codex_work: { state: "none", folder: "~/.codex/skills" },
    });
    const plan = planTurnOff([alone], codex, both);
    expect(plan?.affected).toBe(1);
    expect(plan?.confirmation).toBeUndefined();
  });

  it("says which skills stay on because the agent reads their folder", () => {
    const stays = reached("stays", {
      codex: { state: "direct", folder: "~/.agents/skills", fixed: true },
    });
    const plan = planTurnOff([linked("tdd"), stays], codex, { installed: [codex] });
    expect(plan?.change).toMatchObject({ skills: [ref("tdd")] });
    expect(plan?.confirmation?.notes).toEqual(["1 skill stays on because Codex reads its folder."]);
  });

  it("offers nothing for an agent that uses none of the skills", () => {
    expect(planTurnOff([linked("tdd")], claude, both)).toBeNull();
    const onlyStuck = planTurnOff(
      [reached("stays", { codex: { state: "direct", folder: "~/.agents/skills", fixed: true } })],
      codex,
      both,
    );
    expect(onlyStuck?.affected).toBe(0);
  });
});

/** A global skill kept in an agent's folder itself, so it can move or be deleted. */
const owned = (name: string, extra: Partial<Skill> = {}): Skill => ({
  ...reached(
    name,
    {
      claudeAgent: { state: "link", folder: "~/.claude/skills" },
      codex: { state: "direct", folder: "~/.agents/skills" },
      cursor: { state: "none", folder: "~/.cursor/skills" },
    },
    `~/.agents/skills/${name}`,
  ),
  realFolder: true,
  ...extra,
});

const ownedInProject = (name: string) =>
  owned(name, { scope: "project", home: `.agents/skills/${name}` });

describe("using skills in a project, everywhere or in some projects", () => {
  const web: ProjectOption = { cwd: "/home/user/acme-web", label: "acme-web" };
  const api: ProjectOption = { cwd: "/home/user/acme-api", label: "acme-api" };
  const site: ProjectOption = { cwd: "/home/user/marketing-site", label: "marketing-site" };
  /** A skill kept in the project's shared folder, which Claude reaches through a link. */
  const inProject = (name: string, extra: Partial<Skill> = {}) =>
    owned(name, { scope: "project", home: `.agents/skills/${name}`, ...extra });
  const global = (name: string, extra: Partial<Skill> = {}) => owned(name, extra);
  const usedIn = (name: string, ...projects: ProjectOption[]) =>
    owned(name, { projects: projects.map((project) => project.cwd) });
  const inBoth: PlaceTarget = { kind: "projects", projects: [web, api] };

  it("asks first, and says who will have a skill that becomes Global in some projects", () => {
    const plan = planPlace([inProject("db-migrations")], inBoth);
    expect(plan?.change).toEqual({
      kind: "place",
      skills: [{ scope: "project", name: "db-migrations", home: ".agents/skills/db-migrations" }],
      to: { kind: "projects", cwds: [web.cwd, api.cwd] },
      projectNames: ["acme-web", "acme-api"],
    });
    expect(plan?.confirmation).toEqual({
      title: "Make db-migrations Global?",
      body: "It will be on in acme-web and acme-api. There's one copy, so an edit shows up in both.",
      notes: [],
      confirm: "Make Global",
      destructive: false,
    });
  });

  it("words one project, three projects and several skills", () => {
    expect(
      planPlace([inProject("a")], { kind: "projects", projects: [web] })?.confirmation?.body,
    ).toBe("It will be on in acme-web only.");
    expect(
      planPlace([inProject("a")], { kind: "projects", projects: [web, api, site] })?.confirmation,
    ).toMatchObject({
      body: "It will be on in acme-web, acme-api and marketing-site. There's one copy, so an edit shows up in all of them.",
    });
    expect(
      planPlace([inProject("a"), inProject("b"), inProject("c")], inBoth)?.confirmation,
    ).toMatchObject({
      title: "Make 3 skills Global?",
    });
  });

  it("makes a project skill Global for every project, and a Global one a project's own", () => {
    expect(planPlace([inProject("verify")], { kind: "global" })).toMatchObject({
      change: { kind: "place", to: { kind: "global" }, projectNames: [] },
      confirmation: {
        title: "Make verify Global?",
        body: "It will be on in every project.",
        confirm: "Make Global",
      },
    });
    expect(
      planPlace([global("tdd"), global("grill")], { kind: "project", project: web }),
    ).toMatchObject({
      change: { to: { kind: "project", cwd: web.cwd }, projectNames: ["acme-web"] },
      confirmation: {
        title: "Use 2 skills only in acme-web?",
        body: "It moves into acme-web, so anyone who clones it gets it.",
        confirm: "Move",
      },
    });
  });

  it("doesn't say Global is new for a skill that already is", () => {
    expect(planPlace([global("tdd")], inBoth)?.confirmation).toMatchObject({
      title: "Use tdd only in acme-web and acme-api?",
      confirm: "Apply",
    });
    expect(planPlace([usedIn("tdd", web)], { kind: "global" })?.confirmation).toMatchObject({
      title: "Use tdd in every project?",
    });
  });

  it("leaves out skills that are placed that way already, in any order of projects", () => {
    const plan = planPlace(
      [inProject("new"), usedIn("same", api, web), usedIn("fewer", web), global("everywhere")],
      inBoth,
    );
    expect(plan?.change).toMatchObject({
      skills: [{ name: "new" }, { name: "fewer" }, { name: "everywhere" }],
    });
    expect(plan?.affected).toBe(3);
    expect(planPlace([usedIn("same", api, web)], inBoth)).toBeNull();
    expect(planPlace([global("everywhere")], { kind: "global" })).toBeNull();
    expect(planPlace([inProject("here")], { kind: "project", project: web })).toBeNull();
  });

  it("asks git only about project skills that leave their project", () => {
    const out = planPlace([inProject("a"), global("g"), inProject("b")], inBoth)!;
    expect(skillsToCheckWithGit(out)?.map((item) => item.name)).toEqual(["a", "b"]);
    expect(skillsToCheckWithGit(planPlace([inProject("a")], { kind: "global" })!)).toHaveLength(1);
    // Moving into a project makes new files, so there is nothing in git to undo.
    expect(
      skillsToCheckWithGit(planPlace([global("g")], { kind: "project", project: web })!),
    ).toBeNull();
    expect(skillsToCheckWithGit(planPlace([global("g")], inBoth)!)).toBeNull();
    expect(withGitNote(planPlace([inProject("a")], inBoth)!, ["a"]).confirmation?.notes).toEqual([
      "You can undo this with git.",
    ]);
  });

  it("starts on where the skills are now, with their projects or the picked one ticked", () => {
    expect(startingPlacement([inProject("a")], web)).toEqual({
      choice: "project",
      ticked: [web.cwd],
    });
    expect(startingPlacement([global("g")], web)).toEqual({ choice: "global", ticked: [web.cwd] });
    expect(startingPlacement([usedIn("u", api, site)], web)).toEqual({
      choice: "projects",
      ticked: [api.cwd, site.cwd],
    });
    expect(startingPlacement([global("g")], null)).toEqual({ choice: "global", ticked: [] });
    // Skills in different places start on no choice at all.
    expect(startingPlacement([inProject("a"), global("g")], web).choice).toBeNull();
  });

  it("turns a choice into a placement once it is complete", () => {
    const all = [web, api, site];
    const ticked = new Set([api.cwd, "/home/user/gone"]);
    expect(placeTarget("project", web, all, ticked)).toEqual({ kind: "project", project: web });
    expect(placeTarget("project", null, all, ticked)).toBeNull();
    expect(placeTarget("global", null, all, ticked)).toEqual({ kind: "global" });
    // Only projects that are registered count, in the list's order.
    expect(placeTarget("projects", web, all, ticked)).toEqual({
      kind: "projects",
      projects: [api],
    });
    expect(placeTarget("projects", web, all, new Set())).toBeNull();
    expect(placeTarget("projects", web, all, new Set(["/home/user/gone"]))).toBeNull();
    expect(placeTarget(null, web, all, ticked)).toBeNull();
  });

  it("badges a Global skill that is used in some projects only", () => {
    expect(projectsBadge(usedIn("u", web, api))).toBe("2 projects");
    expect(projectsBadge(usedIn("u", web))).toBe("1 project");
    expect(projectsBadge(global("g"))).toBeNull();
    expect(projectsBadge(inProject("p"))).toBeNull();
  });
});

describe("deleting skills", () => {
  it("names the folder that goes and who stops using the skill", () => {
    const plan = planDelete([owned("tdd")], ctx);
    expect(plan?.change).toEqual({
      kind: "delete",
      skills: [ref("tdd", "~/.agents/skills/tdd")],
    });
    expect(plan?.confirmation).toEqual({
      title: "Delete tdd?",
      body: "This deletes ~/.agents/skills/tdd and any links to it. It can't be undone.",
      notes: ["Claude and Codex will stop using it."],
      confirm: "Delete",
      destructive: true,
    });
  });

  it("counts the folders in a bulk delete and names some of the skills", () => {
    const plan = planDelete(
      ["a", "b", "c", "d", "e", "f"].map((name) => owned(name)),
      ctx,
    );
    expect(plan?.affected).toBe(6);
    expect(plan?.confirmation).toMatchObject({
      title: "Delete 6 skills?",
      body: "This deletes 6 folders and any links to them. It can't be undone.",
      notes: ["“a”, “b”, “c”, “d” and 2 more."],
      destructive: true,
    });
  });

  it("never offers to delete a skill that is only linked", () => {
    const linked = owned("synced", { realFolder: undefined });
    const plan = planDelete([owned("tdd"), linked], ctx);
    expect(plan?.change).toMatchObject({ skills: [{ name: "tdd" }] });
    expect(plan?.confirmation?.notes).toContain("1 skill is reached through a link, so it stays.");
    expect(planDelete([linked], ctx)).toBeNull();
  });

  it("asks git about the project skills only, and not for a global one", () => {
    const plan = planDelete([ownedInProject("a"), owned("g")], ctx)!;
    expect(skillsToCheckWithGit(plan)?.map((skill) => skill.name)).toEqual(["a"]);
    expect(skillsToCheckWithGit(planDelete([owned("g")], ctx)!)).toBeNull();
  });
});

describe("promising an undo with git", () => {
  const delete3 = () =>
    planDelete([ownedInProject("a"), ownedInProject("b"), ownedInProject("c")], ctx)!;

  it("says so once the server has named the skills git tracks", () => {
    expect(
      withGitNote(planDelete([ownedInProject("a")], ctx)!, ["a"]).confirmation?.notes,
    ).toContain("You can undo this with git.");
    expect(withGitNote(delete3(), ["a", "b", "c"]).confirmation?.notes).toContain(
      "You can undo this with git.",
    );
    const some = withGitNote(delete3(), ["a"]).confirmation?.notes;
    expect(some).toContain("1 of these is tracked by git, so you can undo that one with git.");
    expect(withGitNote(delete3(), ["a", "b"]).confirmation?.notes).toContain(
      "2 of these are tracked by git, so you can undo those with git.",
    );
  });

  it("adds nothing when git tracks none of them, and works for a skill leaving a project", () => {
    const plan = delete3();
    expect(withGitNote(plan, [])).toBe(plan);
    expect(withGitNote(plan, ["other"])).toBe(plan);
    expect(
      withGitNote(planPlace([ownedInProject("a")], { kind: "global" })!, ["a"]).confirmation?.notes,
    ).toContain("You can undo this with git.");
  });

  it("leaves the plan's change alone", () => {
    const plan = delete3();
    expect(withGitNote(plan, ["a"]).change).toBe(plan.change);
  });
});

describe("telling what a change did", () => {
  it("says who got a skill, and who else did because they share a folder", () => {
    expect(
      describeResult(
        { kind: "enable", skills: [ref("a"), ref("b")], agents: [claude.instanceId] },
        [outcome({ name: "a", affected: [codex.instanceId] }), outcome({ name: "b" })],
        ctx,
      ),
    ).toBe("Turned on 2 skills for Claude. Codex gets them too.");
    expect(
      describeResult(
        { kind: "disable", skills: [ref("a")], agents: [codex.instanceId] },
        [outcome({ name: "a", affected: [claude.instanceId, ALL[2]!.instanceId] })],
        ctx,
      ),
    ).toBe("Turned off 1 skill for Codex. Claude and Cursor lose it too.");
  });

  it("says where skills went and who else got them, and what a delete took", () => {
    expect(
      describeResult(
        { kind: "place", skills: [ref("a"), ref("b")], to: { kind: "global" }, projectNames: [] },
        [outcome({ name: "a", affected: [codex.instanceId] }), outcome({ name: "b" })],
        ctx,
      ),
    ).toBe("Made 2 skills Global. Codex gets them too.");
    expect(
      describeResult(
        {
          kind: "place",
          skills: [ref("a")],
          to: { kind: "project", cwd: "/p" },
          projectNames: ["acme-web"],
        },
        [outcome({ name: "a" })],
        ctx,
      ),
    ).toBe("Moved 1 skill to acme-web.");
    expect(
      describeResult(
        {
          kind: "place",
          skills: [ref("a"), ref("b")],
          to: { kind: "projects", cwds: ["/p", "/q"] },
          projectNames: ["acme-web", "acme-api"],
        },
        [outcome({ name: "a" }), outcome({ name: "b" })],
        ctx,
      ),
    ).toBe("2 skills now used in acme-web and acme-api.");
    expect(
      describeResult({ kind: "delete", skills: [ref("a")] }, [outcome({ name: "a" })], ctx),
    ).toBe("Deleted 1 skill.");
  });

  it("says why a placement or a delete left a skill alone, or didn't finish", () => {
    expect(
      describeResult(
        { kind: "place", skills: [], to: { kind: "global" }, projectNames: [] },
        [
          outcome({ name: "a", status: "skipped", reason: "destinationTaken" }),
          outcome({ name: "b", status: "skipped", reason: "linked" }),
          outcome({ name: "c", status: "skipped", reason: "inUse" }),
        ],
        ctx,
      ),
    ).toBe(
      "Global already has a “a”, so it stays. “b” is reached through a link, so it stays where it is. “c” is in use by another program, so it wasn't moved.",
    );
    expect(
      describeResult(
        {
          kind: "place",
          skills: [],
          to: { kind: "project", cwd: "/p" },
          projectNames: ["acme-web"],
        },
        [outcome({ name: "a", status: "skipped", reason: "destinationTaken" })],
        ctx,
      ),
    ).toBe("acme-web already has a “a”, so it stays.");
    expect(
      describeResult(
        {
          kind: "place",
          skills: [],
          to: { kind: "projects", cwds: ["/p"] },
          projectNames: ["acme-web"],
        },
        [outcome({ name: "a", status: "skipped", reason: "destinationTaken" })],
        ctx,
      ),
    ).toBe("A project already has a “a”, so it stays.");
    expect(
      describeResult(
        { kind: "place", skills: [ref("a")], to: { kind: "global" }, projectNames: [] },
        [outcome({ name: "a", reason: "failed" })],
        ctx,
      ),
    ).toBe("Made 1 skill Global. “a” moved, but its old folder couldn't be removed.");
    expect(
      describeResult(
        { kind: "delete", skills: [ref("a")] },
        [outcome({ name: "a", reason: "failed" })],
        ctx,
      ),
    ).toBe("Deleted 1 skill. “a” was only partly deleted.");
  });

  it("says why a skill or an agent was skipped, in the person's words", () => {
    expect(
      describeResult(
        { kind: "enable", skills: [ref("a"), ref("b"), ref("c")], agents: [claude.instanceId] },
        [
          outcome({ name: "a" }),
          outcome({
            name: "b",
            status: "skipped",
            blocked: [{ instanceId: claude.instanceId, reason: "entryTaken" }],
          }),
          outcome({ name: "c", status: "skipped", reason: "changed" }),
        ],
        ctx,
      ),
    ).toBe(
      "Turned on 1 skill for Claude. Claude already has a different “b”. “c” changed since the list was read.",
    );
  });

  it("says when a setting outside T3 Code decides, so the switch can't", () => {
    expect(
      describeResult(
        { kind: "disable", skills: [ref("a")], agents: [claude.instanceId] },
        [
          outcome({
            name: "a",
            status: "skipped",
            blocked: [{ instanceId: claude.instanceId, reason: "setElsewhere" }],
          }),
        ],
        ctx,
      ),
    ).toBe("Claude's settings decide “a”, so it stays as it is.");
  });

  it("counts the skills an agent held back for the same reason, instead of listing each", () => {
    const held = (name: string, reason: SkillOutcome["blocked"][number]["reason"]) =>
      outcome({
        name,
        status: "skipped",
        blocked: [{ instanceId: ALL[2]!.instanceId, reason }],
      });
    expect(
      describeResult(
        { kind: "disable", skills: [], agents: [] },
        [held("a", "alwaysOn"), held("b", "alwaysOn"), held("c", "alwaysOn")],
        ctx,
      ),
    ).toBe("Cursor reads 3 skills directly, so they stay on.");
    expect(
      describeResult(
        { kind: "disable", skills: [], agents: [] },
        [held("a", "setElsewhere"), held("b", "setElsewhere"), held("c", "failed")],
        ctx,
      ),
    ).toBe(
      "Cursor's settings decide 2 skills, so they stay as they are. Couldn't change Cursor's folder for “c”.",
    );
  });

  it("names an agent the page doesn't list by its id, and cuts a long list short", () => {
    const blocked = (name: string, reason: SkillOutcome["blocked"][number]["reason"]) =>
      outcome({
        name,
        status: "skipped",
        blocked: [{ instanceId: "pi" as never, reason }],
      });
    expect(
      describeResult(
        { kind: "enable", skills: [], agents: [] },
        [
          blocked("a", "shadowed"),
          blocked("b", "shadowed"),
          blocked("c", "alwaysOn"),
          blocked("d", "failed"),
          blocked("e", "failed"),
        ],
        ctx,
      ),
    ).toBe(
      "pi loads another “a” first. pi loads another “b” first. pi reads “c” directly, so it stays on. 2 more couldn't be changed.",
    );
  });

  it("says plainly when there was nothing to do", () => {
    const unchanged = [outcome({ name: "a", status: "unchanged" })];
    expect(describeResult({ kind: "enable", skills: [], agents: [] }, unchanged, ctx)).toBe(
      "Already on.",
    );
    expect(describeResult({ kind: "disable", skills: [], agents: [] }, unchanged, ctx)).toBe(
      "Already off.",
    );
    expect(
      describeResult(
        { kind: "place", skills: [], to: { kind: "global" }, projectNames: [] },
        unchanged,
        ctx,
      ),
    ).toBe("Already there.");
    expect(describeResult({ kind: "delete", skills: [] }, unchanged, ctx)).toBe(
      "Nothing to delete.",
    );
  });
});

describe("telling that a moved skill lost its source", () => {
  const listed = (name: string, source: string | undefined) =>
    ({
      name,
      scope: "project" as const,
      home: `.agents/skills/${name}`,
      description: `The ${name} skill.`,
      copies: [],
      access: [],
      ...(source === undefined ? {} : { source }),
    }) satisfies SkillListResult["skills"][number];
  const dropped = (name: string) =>
    outcome({
      name,
      skill: { scope: "project", name, home: `.agents/skills/${name}` },
      sourceDropped: true,
    });

  it("names the skill and where it came from, from the plan the page made", () => {
    const { skills } = ingestSkills({
      skills: [listed("write-a-prd", "mattpocock/skills")],
      unreadable: [],
    });
    const plan = planPlace(skills, { kind: "global" });

    expect(describeResult(plan!.change, [dropped("write-a-prd")], ctx)).toBe(
      "Made 1 skill Global. write-a-prd won't update from mattpocock/skills any more.",
    );
  });

  it("counts them when there are several, and says nothing when none lost it", () => {
    const { skills } = ingestSkills({
      skills: [listed("a", "acme/skills"), listed("b", "acme/other")],
      unreadable: [],
    });
    const plan = planPlace(skills, { kind: "global" });

    expect(describeResult(plan!.change, [dropped("a"), dropped("b")], ctx)).toBe(
      "Made 2 skills Global. 2 skills won't update from their sources any more.",
    );
    expect(
      describeResult(plan!.change, [outcome({ name: "a" }), outcome({ name: "b" })], ctx),
    ).toBe("Made 2 skills Global.");
  });
});

describe("a change of more than 200 skills", () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => ref(`s${index}`));

  it("goes to the server in batches of 200, in order, and comes back as one result", async () => {
    const sizes: number[] = [];
    const result = await sendInBatches(many(450), async (batch) => {
      sizes.push(batch.length);
      return batch.map((entry) => outcome({ name: entry.name }));
    });

    expect(sizes).toEqual([200, 200, 50]);
    expect(result.failed).toBe(false);
    expect(result.outcomes.map((entry) => entry.skill.name)).toEqual(
      many(450).map((entry) => entry.name),
    );
  });

  it("sends exactly 200 as one batch, 201 as two, and nothing for no skills", async () => {
    const sizes: number[] = [];
    const send = async (batch: readonly { name: string }[]) => {
      sizes.push(batch.length);
      return batch.map((entry) => outcome({ name: entry.name }));
    };

    await sendInBatches(many(200), send);
    await sendInBatches(many(201), send);
    expect((await sendInBatches([], send)).outcomes).toEqual([]);

    expect(sizes).toEqual([200, 200, 1]);
  });

  it("stops at a batch the server didn't answer, and keeps what was done before it", async () => {
    let calls = 0;
    const result = await sendInBatches(many(450), async (batch) => {
      calls += 1;
      return calls === 2 ? null : batch.map((entry) => outcome({ name: entry.name }));
    });

    expect(calls).toBe(2);
    expect(result.failed).toBe(true);
    expect(result.outcomes).toHaveLength(200);
  });
});
