import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ServerProvider, SkillAgentAccess, SkillListResult } from "@t3tools/contracts";

import {
  agentSkillPath,
  attention,
  availability,
  availabilityNote,
  compareSkillFiles,
  ingestSkills,
  installedAgents,
  matchesQuery,
  scriptFiles,
  skillBody,
  skillsEnvironment,
  unreadableNote,
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

  it("tells where an agent reads the skill, or where it looks when it can't see it", () => {
    const linked = skill("a", { claudeAgent: "link" });
    const withFolder = {
      ...linked,
      access: linked.access.map((item) =>
        item.instanceId === "claudeAgent" ? { ...item, folder: ".claude/skills" } : item,
      ),
    };
    expect(agentSkillPath(withFolder, claude)).toBe(".claude/skills/a");
    expect(agentSkillPath(withFolder, codex)).toBe(".agents/skills");
    expect(agentSkillPath(withFolder, agent("unknown", "pi", "Pi"))).toBeNull();
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
