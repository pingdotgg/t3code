import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type {
  ClaudeInstructionChoice,
  InstructionAgentAccess,
  InstructionEntry,
  InstructionListResult,
} from "@t3tools/contracts";

import {
  claudeChange,
  claudeRows,
  describeAgentsResult,
  describeChange,
  failureText,
  findInstructionRow,
  ingestInstructions,
  instructionActions,
  instructionChips,
  instructionErrorReason,
  instructionAttentionCount,
  instructionItems,
  instructionRows,
  instructionsToCheckWithGit,
  instructionUnreadableNote,
  isSaveConflict,
  matchesClaudeQuery,
  matchesInstructionQuery,
  nestedFiles,
  planClaudeAgents,
  usage,
  usageNote,
  withInstructionGitNote,
  type InstructionData,
} from "./InstructionsSettings.logic";
import type { SkillAgent } from "./SkillsSettings.logic";

const agent = (instanceId: string, driver: string, displayName: string): SkillAgent => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driverKind: ProviderDriverKind.make(driver),
  displayName,
  accentColor: undefined,
});
const claude = agent("claudeAgent", "claudeAgent", "Claude");
const claudeWork = agent("claude_work", "claudeAgent", "Claude Work");
const codex = agent("codex", "codex", "Codex");
const pi = agent("pi", "pi", "Pi");
const ALL = [claude, codex, pi];
const ctx = { installed: ALL };

type Reach = Partial<
  Record<string, Pick<InstructionAgentAccess, "state" | "reason" | "blockingFile">>
>;

/** An entry the way the server reports it; `reach` says how each listed agent gets to it. */
function entry(
  id: string,
  over: Partial<InstructionEntry> = {},
  reach: Reach = {},
  agents: readonly SkillAgent[] = [...ALL, claudeWork],
): InstructionEntry {
  return {
    id,
    scope: "project",
    kind: "shared",
    path: `/home/user/acme-web/${id}`,
    exists: true,
    size: 120,
    readOnly: false,
    access: agents.map((item) => ({
      instanceId: item.instanceId,
      driver: item.driverKind,
      state: "none",
      ...reach[item.instanceId],
    })),
    ...over,
  };
}

const projectAgents = (reach: Reach = {}, over: Partial<InstructionEntry> = {}) =>
  entry(
    "project:shared:AGENTS.md",
    { relativePath: "AGENTS.md", ...over },
    { codex: { state: "direct" }, pi: { state: "direct" }, ...reach },
  );
const projectClaude = (name: string, reach: Reach = { claudeAgent: { state: "direct" } }) => {
  const kind = name === "CLAUDE.local.md" ? "claudeLocal" : "claude";
  return entry(`project:${kind}:${name}`, { kind, relativePath: name }, reach, [claude, codex, pi]);
};
const sharedFile = (reach: Reach = {}, over: Partial<InstructionEntry> = {}) =>
  entry("global:shared", { scope: "global", path: "/home/user/.agents/AGENTS.md", ...over }, reach);
const ownFile = (instanceId: string, over: Partial<InstructionEntry> = {}) =>
  entry(
    `global:agentOwn:${instanceId}`,
    {
      scope: "global",
      kind: "agentOwn",
      owner: ProviderInstanceId.make(instanceId),
      path: `/home/user/.${instanceId}/AGENTS.md`,
      ...over,
    },
    { [instanceId]: { state: "direct" } },
  );

const choice = (
  instanceId: string,
  over: Partial<ClaudeInstructionChoice> = {},
): ClaudeInstructionChoice => ({
  instanceId: ProviderInstanceId.make(instanceId),
  value: "claude-md-or-agents-md",
  explicit: false,
  supported: true,
  version: "2.1.291",
  ...over,
});

const data = (
  entries: InstructionEntry[],
  claudeChoices: ClaudeInstructionChoice[] = [choice("claudeAgent")],
): InstructionData =>
  ingestInstructions({
    entries,
    claude: claudeChoices,
    sharedPath: "/home/user/.agents/AGENTS.md",
    unreadable: [],
  } satisfies InstructionListResult);

const rowsFor = (entries: InstructionEntry[], context = ctx) =>
  instructionRows(data(entries), context);

describe("ingestInstructions", () => {
  it("lists every instance the server mentions, in an entry or in Claude's choices", () => {
    const { known } = ingestInstructions({
      entries: [projectAgents()],
      claude: [choice("claude_extra")],
      sharedPath: "/home/user/.agents/AGENTS.md",
      unreadable: [],
    });
    expect([...known].toSorted()).toEqual([
      "claudeAgent",
      "claude_extra",
      "claude_work",
      "codex",
      "pi",
    ]);
  });
});

describe("the rows", () => {
  const managed = (reach: Reach = { claudeAgent: { state: "direct" } }) =>
    entry(
      "managed:claude",
      { scope: "managed", kind: "managed", readOnly: true, path: "/etc/claude-code/CLAUDE.md" },
      reach,
    );

  it("titles each file with its name, and says nothing else on the row", () => {
    const rows = rowsFor([
      projectAgents(),
      projectClaude("CLAUDE.md"),
      projectClaude(".claude/CLAUDE.md"),
      projectClaude("CLAUDE.local.md"),
      sharedFile(),
      managed(),
    ]);
    expect(rows.map((row) => [row.title, row.group, row.attention])).toEqual([
      ["AGENTS.md", "project", null],
      ["CLAUDE.md", "project", expect.anything()],
      [".claude/CLAUDE.md", "project", null],
      ["CLAUDE.local.md", "project", null],
      ["AGENTS.md", "global", expect.anything()],
      ["Set by your organization", "global", null],
    ]);
  });

  it("gives the open file the same heading, with its group or its file name under it", () => {
    const rows = rowsFor([
      projectAgents(),
      projectClaude("CLAUDE.md"),
      projectClaude("CLAUDE.local.md"),
      sharedFile(),
      managed(),
    ]);
    expect(rows.map((row) => [row.heading, row.headingNote])).toEqual([
      ["AGENTS.md", "Project"],
      ["CLAUDE.md", "Project"],
      ["CLAUDE.local.md", "Project"],
      ["AGENTS.md", "Global"],
      ["Set by your organization", "CLAUDE.md"],
    ]);
  });

  it("puts a missing project file, CLAUDE.local.md and Global file up for creating", () => {
    const local = { ...projectClaude("CLAUDE.local.md"), exists: false, size: 0 };
    const rows = rowsFor([
      projectAgents({}, { exists: false, size: 0 }),
      local,
      sharedFile({}, { exists: false, size: 0 }),
    ]);
    expect(rows.map((row) => [row.title, row.missing, row.attention])).toEqual([
      ["AGENTS.md", true, null],
      ["CLAUDE.local.md", true, null],
      ["AGENTS.md", true, null],
    ]);
  });

  it("leaves out every other file that isn't there, and the subfolder files", () => {
    expect(
      rowsFor([
        projectClaude("CLAUDE.md"),
        entry("project:nested:apps/web/AGENTS.md", {
          kind: "nested",
          relativePath: "apps/web/AGENTS.md",
        }),
        { ...projectClaude(".claude/CLAUDE.md"), exists: false },
        { ...ownFile("codex"), exists: false },
      ]).map((row) => row.title),
    ).toEqual(["CLAUDE.md"]);
  });

  it("puts the project's files first, then Global's, then the organization's", () => {
    const rows = rowsFor([
      managed(),
      entry(
        "global:claude:claudeAgent",
        {
          scope: "global",
          kind: "claude",
          path: "/home/user/.claude/CLAUDE.md",
          owner: ProviderInstanceId.make("claudeAgent"),
        },
        { claudeAgent: { state: "direct" } },
      ),
      sharedFile(),
      projectClaude("CLAUDE.local.md"),
      projectClaude("CLAUDE.md"),
      projectAgents(),
    ]);
    expect(rows.map((row) => [row.group, row.title])).toEqual([
      ["project", "AGENTS.md"],
      ["project", "CLAUDE.md"],
      ["project", "CLAUDE.local.md"],
      ["global", "AGENTS.md"],
      ["global", "CLAUDE.md"],
      ["global", "Set by your organization"],
    ]);
  });

  it("names whose CLAUDE.md it is only when two Claude instances each have one", () => {
    const withTwo = { installed: [claude, claudeWork] };
    const own = (instanceId: string) =>
      entry(
        `global:claude:${instanceId}`,
        {
          scope: "global",
          kind: "claude",
          path: "/home/user/.claude/CLAUDE.md",
          owner: ProviderInstanceId.make(instanceId),
        },
        { [instanceId]: { state: "direct" } },
      );
    expect(rowsFor([own("claudeAgent"), own("claude_work")], withTwo).map((r) => r.title)).toEqual([
      "Claude's CLAUDE.md",
      "Claude Work's CLAUDE.md",
    ]);
    expect(rowsFor([own("claudeAgent")], withTwo).map((r) => r.title)).toEqual(["CLAUDE.md"]);
    // A second instance that isn't installed doesn't count.
    expect(
      rowsFor([own("claudeAgent"), own("claude_work")], { installed: [claude] }).map(
        (r) => r.title,
      ),
    ).toEqual(["CLAUDE.md"]);
  });

  it("lists no file that no installed agent reads, except the AGENTS.md files", () => {
    const nobody: Reach = {};
    const withoutClaude = { installed: [codex, pi] };
    const reading = [
      projectAgents(),
      projectClaude("CLAUDE.md"),
      projectClaude("CLAUDE.local.md"),
      sharedFile(),
      managed(),
    ];
    // Claude is off: only it read these three, so their rows go.
    expect(rowsFor(reading, withoutClaude).map((row) => row.title)).toEqual([
      "AGENTS.md",
      "AGENTS.md",
    ]);
    // Another agent that reads the file keeps its row.
    expect(
      rowsFor(
        [projectClaude("CLAUDE.md", { codex: { state: "direct" } }), managed(nobody)],
        withoutClaude,
      ).map((row) => row.title),
    ).toEqual(["CLAUDE.md"]);
    expect(rowsFor(reading).map((row) => row.title)).toHaveLength(5);
  });

  it("leaves out a missing project AGENTS.md next to a CLAUDE.md, since moving makes it", () => {
    const missing = projectAgents({}, { exists: false, size: 0 });
    const titles = (entries: InstructionEntry[]) => rowsFor(entries).map((row) => row.title);
    // Only when neither file exists does the project offer to create AGENTS.md.
    expect(titles([missing])).toEqual(["AGENTS.md"]);
    expect(titles([missing, projectClaude("CLAUDE.md")])).toEqual(["CLAUDE.md"]);
    // Only the top-folder CLAUDE.md offers the move, so .claude/CLAUDE.md keeps the Create row.
    expect(titles([missing, projectClaude(".claude/CLAUDE.md")])).toEqual([
      "AGENTS.md",
      ".claude/CLAUDE.md",
    ]);
    // An AGENTS.md that exists stays, and so does one next to CLAUDE.local.md alone.
    expect(titles([projectAgents(), projectClaude("CLAUDE.md")])).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(titles([missing, projectClaude("CLAUDE.local.md")])).toEqual([
      "AGENTS.md",
      "CLAUDE.local.md",
    ]);
  });

  it("gives an agent's own Global file no row, but opens it by its id", () => {
    const own = ownFile("codex");
    const all = data([sharedFile(), own]);
    expect(instructionRows(all, ctx).map((row) => row.title)).toEqual(["AGENTS.md"]);
    expect(findInstructionRow(all, ctx, own.id)).toMatchObject({
      title: "Codex's AGENTS.md",
      heading: "Codex's AGENTS.md",
      headingNote: "Global",
    });
    // Its agent has to be installed.
    expect(findInstructionRow(all, { installed: [claude] }, own.id)).toBeNull();
  });

  it("opens a subfolder file by its file name, with its folder under it", () => {
    const nested = entry("project:nested:apps/web/AGENTS.md", {
      kind: "nested",
      relativePath: "apps/web/AGENTS.md",
    });
    const all = data([projectAgents(), nested]);
    expect(findInstructionRow(all, ctx, nested.id)).toMatchObject({
      title: "AGENTS.md",
      heading: "AGENTS.md",
      headingNote: "In apps/web",
    });
    expect(findInstructionRow(all, ctx, "gone")).toBeNull();
  });

  it("expands only the Global file, and only once it exists", () => {
    const rows = rowsFor([projectAgents(), projectClaude("CLAUDE.local.md"), sharedFile()]);
    expect(rows.map((row) => [row.group, row.title, row.expandable])).toEqual([
      ["project", "AGENTS.md", false],
      ["project", "CLAUDE.local.md", false],
      ["global", "AGENTS.md", true],
    ]);
    expect(rowsFor([sharedFile({}, { exists: false })])[0]!.expandable).toBe(false);
  });
});

describe("the card's items", () => {
  const nested = (path: string) =>
    entry(`project:nested:${path}`, { kind: "nested", relativePath: path });
  const entries = [
    projectAgents(),
    projectClaude("CLAUDE.local.md"),
    nested("packages/api/CLAUDE.md"),
    nested("apps/web/AGENTS.md"),
    sharedFile(),
    ownFile("codex"),
  ];
  const labels = (view: { needle: string; onlyAttention: boolean }, list = entries) =>
    instructionItems(data(list), ctx, view).map((item) => {
      switch (item.kind) {
        case "group":
          return `# ${item.label}`;
        case "file":
          return `${item.row.group}:${item.row.title}`;
        case "claude":
          return item.row.title;
        case "subfolders":
          return `${item.files.length} in subfolders`;
      }
    });

  it("puts the project's files and the subfolder files under Project, and Global's under Global", () => {
    expect(labels({ needle: "", onlyAttention: false })).toEqual([
      "# Project",
      "project:AGENTS.md",
      "project:CLAUDE.local.md",
      "2 in subfolders",
      "# Global",
      "global:AGENTS.md",
      "Claude reads AGENTS.md",
    ]);
  });

  it("shows a heading only when something is under it", () => {
    // The subfolder files and the project's files all miss "global".
    expect(labels({ needle: "global", onlyAttention: false })).toEqual([
      "# Global",
      "global:AGENTS.md",
    ]);
    expect(labels({ needle: "apps/web", onlyAttention: false })).toEqual([
      "# Project",
      "1 in subfolders",
    ]);
    expect(labels({ needle: "tdd", onlyAttention: false })).toEqual([]);
    // Without a project only Global appears, with its heading.
    expect(
      instructionItems(data([sharedFile()], []), ctx, { needle: "", onlyAttention: false }).map(
        (item) => item.kind,
      ),
    ).toEqual(["group", "file"]);
  });

  it("keeps only what needs attention under that filter", () => {
    // Nobody reads the Global file yet, and the project's files are fine.
    expect(labels({ needle: "", onlyAttention: true })).toEqual(["# Global", "global:AGENTS.md"]);
    expect(instructionAttentionCount(data(entries), ctx)).toBe(1);
  });
});

describe("who uses a file", () => {
  it("shows one mark when every installed agent the file lists reads it", () => {
    const value = usage(
      sharedFile({
        claudeAgent: { state: "import" },
        codex: { state: "link" },
        pi: { state: "link" },
      }),
      ctx,
    );
    expect(value).toMatchObject({ everyone: true, missing: [] });
    expect(usageNote(value)).toBe("Used by all your agents");
  });

  it("names the agents that don't, and ignores agents the file doesn't list", () => {
    const value = usage(projectClaude("CLAUDE.md"), ctx);
    expect(value.agents).toEqual([claude]);
    expect(value.missing).toEqual([codex, pi]);
    expect(usageNote(value)).toBe("Not used by Codex and Pi");
    expect(usage(entry("x", {}, {}, [claude]), { installed: [codex] })).toEqual({
      everyone: false,
      agents: [],
      missing: [],
    });
  });
});

describe("what needs attention", () => {
  it("says when Claude skips AGENTS.md because of another file, and offers to turn it on", () => {
    const [row] = rowsFor([
      projectAgents({
        claudeAgent: { state: "none", reason: "claudeFiles", blockingFile: "CLAUDE.local.md" },
      }),
    ]);
    expect(row!.attention).toMatchObject({
      detail: "Claude skips it because of CLAUDE.local.md",
      fix: { label: "Turn on for Claude" },
    });
    expect(row!.attention!.fix!.plan).toEqual({
      change: {
        kind: "setClaude",
        instances: ["claudeAgent"],
        value: "claude-md-and-agents-md",
      },
      confirmation: {
        title: "Turn on AGENTS.md for Claude?",
        body: "Claude will read AGENTS.md in every project, together with your CLAUDE.md files.",
        notes: [],
        confirm: "Turn on",
        destructive: false,
      },
    });
  });

  it("names each Claude instance that skips it, and every file in the way", () => {
    const [row] = rowsFor(
      [
        projectAgents({
          claudeAgent: { state: "none", reason: "claudeFiles", blockingFile: "CLAUDE.md" },
          claude_work: { state: "none", reason: "claudeFiles", blockingFile: "CLAUDE.local.md" },
        }),
      ],
      { installed: [claude, claudeWork, codex, pi] },
    );
    expect(row!.attention!.detail).toBe(
      "Claude and Claude Work skip it because of CLAUDE.md and CLAUDE.local.md",
    );
    expect(row!.attention!.fix!.label).toBe("Turn on for Claude");
    expect(row!.attention!.fix!.plan.change).toMatchObject({
      instances: ["claudeAgent", "claude_work"],
    });
  });

  it("names a single Claude instance by its own name", () => {
    const [row] = rowsFor(
      [
        projectAgents({
          claude_work: { state: "none", reason: "claudeFiles", blockingFile: "CLAUDE.md" },
        }),
      ],
      { installed: [claudeWork, codex, pi] },
    );
    expect(row!.attention!.fix!.label).toBe("Turn on for Claude Work");
    expect(row!.attention!.fix!.plan.confirmation!.title).toBe(
      "Turn on AGENTS.md for Claude Work?",
    );
  });

  it("leaves AGENTS.md alone when Claude reads it, or the person chose not to", () => {
    const reading = { claudeAgent: { state: "setting" as const } };
    expect(rowsFor([projectAgents(reading)])[0]!.attention).toBeNull();
    const never = { claudeAgent: { state: "none" as const, reason: "settingOff" as const } };
    expect(rowsFor([projectAgents(never)])[0]!.attention).toBeNull();
    const old = { claudeAgent: { state: "none" as const, reason: "oldVersion" as const } };
    expect(rowsFor([projectAgents(old)])[0]!.attention).toBeNull();
  });

  it("says which agents don't use Global, and offers to turn it on", () => {
    const [row] = rowsFor([
      sharedFile({ claudeAgent: { state: "import" }, codex: { state: "link" } }),
    ]);
    expect(row!.attention).toMatchObject({
      detail: "Not used by Pi",
      fix: { label: "Turn on for Pi" },
    });
    expect(row!.attention!.fix!.plan).toEqual({
      change: { kind: "enable", id: "global:shared", agents: ["pi"] },
    });
  });

  it("turns on for all agents when several lack Global", () => {
    const [row] = rowsFor([sharedFile({ claudeAgent: { state: "import" } })]);
    expect(row!.attention).toMatchObject({
      detail: "Not used by Codex and Pi",
      fix: { label: "Turn on for all agents" },
    });
  });

  it("doesn't blame an agent that is too old, or one that keeps a file we can't find", () => {
    const reach: Reach = {
      claudeAgent: { state: "import" },
      codex: { state: "none", reason: "ownFile" },
      pi: { state: "none", reason: "oldVersion" },
    };
    expect(rowsFor([sharedFile(reach)])[0]!.attention).toBeNull();
  });

  it("offers a missing Global file nothing to fix", () => {
    expect(rowsFor([sharedFile({}, { exists: false })])[0]!.attention).toBeNull();
  });

  describe("an agent that keeps its own Global file", () => {
    const keeps: Reach = {
      claudeAgent: { state: "import" },
      codex: { state: "none", reason: "ownFile" },
      pi: { state: "none", reason: "ownFile" },
    };
    const global = (list: InstructionEntry[], context = ctx) =>
      rowsFor(list, context).find((row) => row.group === "global")!;

    it("says so on Global, with a fix that takes the agent's file in", () => {
      const row = global([sharedFile({ ...keeps, pi: { state: "link" } }), ownFile("codex")]);
      expect(row.attention).toMatchObject({
        detail: "Codex uses its own AGENTS.md instead",
        fix: { label: "Use Global instead" },
      });
      expect(row.attention!.fix!.plan).toEqual({
        change: { kind: "adopt", ids: ["global:agentOwn:codex"], names: ["Codex"] },
        confirmation: {
          title: "Use your Global instructions for Codex?",
          body: "Codex's instructions are added to your Global instructions. Codex then reads them instead.",
          notes: [],
          confirm: "Use Global instead",
          destructive: false,
        },
      });
    });

    it("takes every such agent in one confirmation", () => {
      const row = global([sharedFile(keeps), ownFile("codex"), ownFile("pi")]);
      expect(row.attention!.detail).toBe("Codex and Pi use their own AGENTS.md instead");
      expect(row.attention!.fix!.plan).toEqual({
        change: {
          kind: "adopt",
          ids: ["global:agentOwn:codex", "global:agentOwn:pi"],
          names: ["Codex", "Pi"],
        },
        confirmation: {
          title: "Use your Global instructions for Codex and Pi?",
          body: "Codex and Pi's instructions are added to your Global instructions. They then read them instead.",
          notes: [],
          confirm: "Use Global instead",
          destructive: false,
        },
      });
    });

    it("says they just start using Global when every file matches it", () => {
      const same = { sameAsShared: true };
      const both = global([sharedFile(keeps), ownFile("codex", same), ownFile("pi", same)]);
      expect(both.attention!.fix!.plan.confirmation!.body).toBe(
        "Codex and Pi's instructions match your Global instructions, so they just start using them.",
      );
      const one = global([sharedFile(keeps), ownFile("codex", same), ownFile("pi")]);
      expect(one.attention!.fix!.plan.confirmation!.body).toBe(
        "Codex and Pi's instructions are added to your Global instructions. They then read them instead.",
      );
      const single = global([
        sharedFile({ ...keeps, pi: { state: "link" } }),
        ownFile("codex", same),
      ]);
      expect(single.attention!.fix!.plan.confirmation!.body).toBe(
        "Codex's instructions match your Global instructions, so Codex just starts using them.",
      );
    });

    it("turns agents on first, when some simply can be", () => {
      const row = global([sharedFile({ ...keeps, pi: { state: "none" } }), ownFile("codex")]);
      expect(row.attention).toMatchObject({
        detail: "Not used by Pi",
        fix: { label: "Turn on for Pi" },
      });
    });

    it("needs the agent installed and a file of its own to take", () => {
      expect(global([sharedFile(keeps)]).attention).toBeNull();
      expect(
        global([sharedFile(keeps), ownFile("codex")], { installed: [claude, pi] }).attention,
      ).toBeNull();
      expect(
        global([sharedFile(keeps), { ...ownFile("codex"), exists: false }]).attention,
      ).toBeNull();
    });
  });

  describe("a project's CLAUDE.md", () => {
    const noAgents = () => projectAgents({}, { exists: false });
    const claudeMdRow = (list: InstructionEntry[]) =>
      rowsFor(list).find((row) => row.title === "CLAUDE.md")!;

    it("offers to move it to AGENTS.md when no AGENTS.md sits beside it", () => {
      const row = claudeMdRow([noAgents(), projectClaude("CLAUDE.md")]);
      expect(row.attention).toMatchObject({
        detail: "Not used by Codex and Pi",
        fix: { label: "Move to AGENTS.md" },
      });
      expect(row.attention!.fix!.plan).toEqual({
        change: {
          kind: "share",
          id: "project:claude:CLAUDE.md",
          project: true,
          merge: false,
          claude: [],
        },
        confirmation: {
          title: "Move CLAUDE.md to AGENTS.md?",
          body: "Every agent reads AGENTS.md, so Codex and Pi get these instructions too.",
          notes: [],
          confirm: "Move",
          destructive: false,
        },
      });
      // Only the one in the top folder can move.
      expect(rowsFor([noAgents(), projectClaude(".claude/CLAUDE.md")])[0]!.attention).toBeNull();
    });

    it("offers to merge it into the AGENTS.md that is there", () => {
      const row = claudeMdRow([projectAgents(), projectClaude("CLAUDE.md")]);
      expect(row.attention).toMatchObject({
        detail: "Not used by Codex and Pi",
        fix: { label: "Merge into AGENTS.md" },
      });
      expect(row.attention!.fix!.plan).toEqual({
        change: {
          kind: "share",
          id: "project:claude:CLAUDE.md",
          project: true,
          merge: true,
          claude: [],
        },
        confirmation: {
          title: "Merge CLAUDE.md into AGENTS.md?",
          body: "Its text goes at the end of AGENTS.md, then CLAUDE.md is deleted. Every agent reads AGENTS.md from then on.",
          notes: [],
          confirm: "Merge",
          destructive: false,
        },
      });
    });

    it("leaves it alone when every agent reads it already", () => {
      const everyone = entry(
        "project:claude:CLAUDE.md",
        { kind: "claude", relativePath: "CLAUDE.md" },
        { claudeAgent: { state: "direct" }, codex: { state: "direct" }, pi: { state: "direct" } },
      );
      expect(rowsFor([noAgents(), everyone])[0]!.attention).toBeNull();
      expect(rowsFor([projectAgents(), everyone])[1]!.attention).toBeNull();
    });

    it("says nobody is missing in the move, when that is so", () => {
      const only = entry(
        "project:claude:CLAUDE.md",
        { kind: "claude", relativePath: "CLAUDE.md" },
        { claudeAgent: { state: "direct" } },
        [claude],
      );
      const [row] = rowsFor([noAgents(), only]);
      expect(row!.attention).toBeNull();
      const actions = instructionActions(row!, ctx, data([noAgents(), only]));
      expect(actions.share!.plan.confirmation!.body).toBe("Every agent reads AGENTS.md.");
    });
  });

  it("never flags a file the person can't change", () => {
    const managed = entry(
      "managed:claude",
      { scope: "managed", kind: "managed", readOnly: true },
      { claudeAgent: { state: "direct" } },
    );
    expect(rowsFor([managed])[0]!.attention).toBeNull();
  });
});

describe("Claude's choice", () => {
  it("has one row per installed Claude, named only when there are several", () => {
    const one = claudeRows([choice("claudeAgent")], ctx);
    expect(one.map((row) => row.title)).toEqual(["Claude reads AGENTS.md"]);
    const two = claudeRows([choice("claudeAgent"), choice("claude_work")], {
      installed: [claude, claudeWork],
    });
    expect(two.map((row) => row.title)).toEqual([
      "Claude reads AGENTS.md",
      "Claude Work reads AGENTS.md",
    ]);
    expect(claudeRows([choice("gone")], ctx)).toEqual([]);
  });

  it("shows what applies now, whether the person chose it or it is the default", () => {
    const [row] = claudeRows([choice("claudeAgent", { value: "claude-md-and-agents-md" })], ctx);
    expect(row!.control).toEqual({
      kind: "select",
      value: "claude-md-and-agents-md",
      label: "Alongside any CLAUDE.md",
      disabled: false,
    });
    expect(claudeRows([choice("claudeAgent")], ctx)[0]!.control).toMatchObject({
      label: "When there's no CLAUDE.md",
    });
    expect(
      claudeRows([choice("claudeAgent", { value: "claude-md" })], ctx)[0]!.control,
    ).toMatchObject({ label: "Never" });
  });

  it("says plainly when the organization decides", () => {
    const [row] = claudeRows([choice("claudeAgent", { value: "managed-only" })], ctx);
    expect(row!.control).toEqual({ kind: "text", text: "Organization only" });
    expect(row!.note).toBeNull();
  });

  it("disables the choice and says why when Claude is too old", () => {
    const [row] = claudeRows([choice("claudeAgent", { supported: false, version: "2.0.1" })], ctx);
    expect(row!.control).toMatchObject({ kind: "select", disabled: true });
    expect(row!.note).toBe("Needs Claude Code 2.1.277 or later");
    expect(claudeRows([choice("claudeAgent")], ctx)[0]!.note).toBeNull();
  });

  it("stores the default as no value, and asks for nothing when nothing changes", () => {
    const base = { instanceId: ProviderInstanceId.make("claudeAgent") };
    expect(
      claudeChange({ ...base, value: "claude-md", explicit: true }, "claude-md-or-agents-md"),
    ).toEqual({ kind: "setClaude", instances: ["claudeAgent"], value: null });
    expect(
      claudeChange(
        { ...base, value: "claude-md-or-agents-md", explicit: false },
        "claude-md-or-agents-md",
      ),
    ).toBeNull();
    expect(
      claudeChange(
        { ...base, value: "claude-md-or-agents-md", explicit: true },
        "claude-md-or-agents-md",
      ),
    ).toEqual({ kind: "setClaude", instances: ["claudeAgent"], value: null });
    expect(
      claudeChange({ ...base, value: "claude-md-or-agents-md", explicit: false }, "claude-md"),
    ).toEqual({ kind: "setClaude", instances: ["claudeAgent"], value: "claude-md" });
    expect(claudeChange({ ...base, value: "claude-md", explicit: true }, "claude-md")).toBeNull();
  });
});

describe("subfolder files", () => {
  it("lists the folders in order, with the file in each", () => {
    const nested = (path: string) =>
      entry(`project:nested:${path}`, { kind: "nested", relativePath: path });
    expect(
      nestedFiles([
        nested("packages/api/CLAUDE.md"),
        nested("apps/web/AGENTS.md"),
        nested("apps/10/AGENTS.md"),
        nested("apps/2/AGENTS.md"),
        { ...nested("apps/gone/AGENTS.md"), exists: false },
        projectAgents(),
      ]).map((item) => [item.folder, item.file]),
    ).toEqual([
      ["apps/2", "AGENTS.md"],
      ["apps/10", "AGENTS.md"],
      ["apps/web", "AGENTS.md"],
      ["packages/api", "CLAUDE.md"],
    ]);
  });
});

describe("the agents under Used by", () => {
  const chipsFor = (
    item: InstructionEntry,
    extra: InstructionEntry[] = [],
    choices = [choice("claudeAgent")],
  ) => instructionChips(item, ctx, data([item, ...extra], choices));

  it("says Claude reads the project AGENTS.md through the project's CLAUDE.md", () => {
    const chip = chipsFor(projectAgents({ claudeAgent: { state: "import" } })).find(
      (item) => item.agent.instanceId === "claudeAgent",
    )!;
    expect(chip.lines).toEqual(["Claude reads it through the project's CLAUDE.md."]);
  });

  it("locks an agent that reads the file where it is", () => {
    const chip = chipsFor(projectAgents()).find((item) => item.agent.instanceId === "codex")!;
    expect(chip).toMatchObject({ on: true, locked: true, plan: null });
    expect(chip.lines).toEqual(["Always on. It reads this file directly."]);
  });

  it("switches an agent on or off for Global", () => {
    const shared = sharedFile({
      claudeAgent: { state: "import" },
      codex: { state: "link" },
      pi: { state: "none" },
    });
    const byAgent = Object.fromEntries(
      chipsFor(shared).map((chip) => [chip.agent.instanceId, chip]),
    );
    expect(byAgent.codex).toMatchObject({
      on: true,
      locked: false,
      plan: { change: { kind: "disable", id: "global:shared", agents: ["codex"] } },
    });
    expect(byAgent.claudeAgent!.lines).toEqual([
      "Claude imports this file from its own CLAUDE.md.",
    ]);
    expect(byAgent.pi).toMatchObject({
      on: false,
      locked: false,
      plan: { change: { kind: "enable", id: "global:shared", agents: ["pi"] } },
    });
  });

  it("asks before switching on an agent that keeps its own file, and uses its file to do it", () => {
    const shared = sharedFile({ codex: { state: "none", reason: "ownFile" } });
    const own = ownFile("codex");
    const chip = chipsFor(shared, [own]).find((item) => item.agent.instanceId === "codex")!;
    expect(chip.locked).toBe(false);
    expect(chip.plan).toMatchObject({
      change: { kind: "adopt", ids: ["global:agentOwn:codex"], names: ["Codex"] },
      confirmation: { title: "Use your Global instructions for Codex?" },
    });
    // With no file of its own to find, there is nothing to switch.
    expect(chipsFor(shared).find((item) => item.agent.instanceId === "codex")).toMatchObject({
      locked: true,
      plan: null,
    });
  });

  it("locks an agent that is too old for Global", () => {
    const shared = sharedFile({ pi: { state: "none", reason: "oldVersion" } });
    expect(chipsFor(shared).find((item) => item.agent.instanceId === "pi")).toMatchObject({
      locked: true,
      plan: null,
    });
  });

  it("turns Claude's chip on AGENTS.md into the same confirmed choice as the fix", () => {
    const skipped = projectAgents({
      claudeAgent: { state: "none", reason: "claudeFiles", blockingFile: "CLAUDE.local.md" },
    });
    const chip = chipsFor(skipped).find((item) => item.agent.instanceId === "claudeAgent")!;
    expect(chip).toMatchObject({ on: false, locked: false });
    expect(chip.plan).toEqual(planClaudeAgents([ProviderInstanceId.make("claudeAgent")], ctx));
    expect(chip.lines).toEqual(["Claude skips it because of CLAUDE.local.md."]);
  });

  it("asks before turning Claude off for AGENTS.md in every project", () => {
    const reading = projectAgents({ claudeAgent: { state: "setting" } });
    const chip = chipsFor(reading).find((item) => item.agent.instanceId === "claudeAgent")!;
    expect(chip).toMatchObject({ on: true, locked: false });
    expect(chip.plan).toMatchObject({
      change: { kind: "setClaude", instances: ["claudeAgent"], value: "claude-md" },
      confirmation: {
        title: "Turn off AGENTS.md for Claude?",
        body: "Claude will stop reading AGENTS.md in every project.",
        confirm: "Turn off",
      },
    });
  });

  it("locks Claude's chip when an import, the organization or an old version decides", () => {
    const imported = projectAgents({ claudeAgent: { state: "import" } });
    expect(chipsFor(imported).find((c) => c.agent.instanceId === "claudeAgent")).toMatchObject({
      on: true,
      locked: true,
    });
    const managed = projectAgents({ claudeAgent: { state: "none" } });
    expect(
      chipsFor(managed, [], [choice("claudeAgent", { value: "managed-only" })]).find(
        (c) => c.agent.instanceId === "claudeAgent",
      ),
    ).toMatchObject({ locked: true, lines: ["Your organization decides this."] });
    const old = projectAgents({ claudeAgent: { state: "none", reason: "oldVersion" } });
    expect(chipsFor(old).find((c) => c.agent.instanceId === "claudeAgent")).toMatchObject({
      locked: true,
      lines: ["Needs Claude Code 2.1.277 or later."],
    });
  });

  it("only shows who reads any other file", () => {
    const chips = chipsFor(projectClaude("CLAUDE.md"));
    expect(chips.map((chip) => [chip.agent.displayName, chip.on, chip.locked])).toEqual([
      ["Claude", true, true],
      ["Codex", false, true],
      ["Pi", false, true],
    ]);
  });
});

describe("the ⋯ menu", () => {
  const actionsFor = (
    entries: InstructionEntry[],
    index: number,
    context = ctx,
    choices?: ClaudeInstructionChoice[],
  ) => {
    const all = data(entries, choices);
    const row = findInstructionRow(all, context, entries[index]!.id)!;
    return instructionActions(row, context, all);
  };

  it("turns Global on for the agents that lack it and can take it", () => {
    const shared = sharedFile({
      claudeAgent: { state: "import" },
      codex: { state: "none", reason: "ownFile" },
      pi: { state: "none" },
    });
    expect(actionsFor([shared], 0).turnOnAll).toEqual({
      change: { kind: "enable", id: "global:shared", agents: ["pi"] },
    });
  });

  it("removes Global from the agents that read it, and says the file stays", () => {
    const shared = sharedFile({ claudeAgent: { state: "import" }, codex: { state: "link" } });
    expect(actionsFor([shared], 0).removeFromAgents).toEqual({
      change: { kind: "disable", id: "global:shared", agents: ["claudeAgent", "codex"] },
      confirmation: {
        title: "Stop using your Global instructions?",
        body: "Claude and Codex will stop reading them. The file isn't deleted.",
        notes: [],
        confirm: "Remove",
        destructive: true,
      },
    });
    expect(actionsFor([sharedFile()], 0).removeFromAgents).toBeNull();
  });

  it("moves or merges a project's CLAUDE.md, labelled for which it is", () => {
    const claudeMd = projectClaude("CLAUDE.md");
    const move = actionsFor([projectAgents({}, { exists: false }), claudeMd], 1).share;
    expect(move).toMatchObject({
      label: "Move to AGENTS.md",
      plan: { change: { kind: "share", merge: false } },
    });
    const merge = actionsFor([projectAgents(), claudeMd], 1).share;
    expect(merge).toMatchObject({
      label: "Merge into AGENTS.md",
      plan: { change: { kind: "share", merge: true } },
    });
    // Only the top folder's CLAUDE.md, and only while it is there.
    expect(
      actionsFor([projectAgents({}, { exists: false }), projectClaude(".claude/CLAUDE.md")], 1)
        .share,
    ).toBeNull();
    expect(actionsFor([projectAgents(), { ...claudeMd, exists: false }], 1).share).toBeNull();
  });

  it("offers the merge even when no agent is missing out", () => {
    const only = entry(
      "project:claude:CLAUDE.md",
      { kind: "claude", relativePath: "CLAUDE.md" },
      { claudeAgent: { state: "direct" } },
      [claude],
    );
    expect(actionsFor([projectAgents(), only], 1).share).toMatchObject({
      label: "Merge into AGENTS.md",
    });
  });

  it("uses Global for an agent's own, whatever its text", () => {
    const own = ownFile("codex", { sameAsShared: true });
    expect(actionsFor([own], 0).useGlobal).toMatchObject({
      change: { kind: "adopt", names: ["Codex"] },
      confirmation: {
        body: "Codex's instructions match your Global instructions, so Codex just starts using them.",
      },
    });
  });

  it("deletes real files other than the AGENTS.md ones, and names the file", () => {
    expect(actionsFor([projectClaude("CLAUDE.md")], 0).remove).toEqual({
      change: { kind: "delete", id: "project:claude:CLAUDE.md", name: "CLAUDE.md", project: true },
      confirmation: {
        title: "Delete CLAUDE.md?",
        body: "This deletes CLAUDE.md.",
        notes: ["This can't be undone."],
        confirm: "Delete",
        destructive: true,
      },
    });
    expect(actionsFor([ownFile("codex")], 0).remove).toMatchObject({
      change: { kind: "delete", name: "Codex's AGENTS.md", project: false },
    });
    expect(actionsFor([projectClaude("CLAUDE.local.md")], 0).remove).toMatchObject({
      change: { kind: "delete", name: "CLAUDE.local.md", project: true },
      confirmation: { title: "Delete CLAUDE.local.md?" },
    });
    // A subfolder file is named by its path, since its title is only AGENTS.md.
    const nested = entry("project:nested:apps/web/AGENTS.md", {
      kind: "nested",
      relativePath: "apps/web/AGENTS.md",
    });
    expect(actionsFor([nested], 0).remove).toMatchObject({
      change: { kind: "delete", name: "apps/web/AGENTS.md" },
    });
    expect(actionsFor([projectAgents()], 0).remove).toBeNull();
    expect(actionsFor([sharedFile()], 0).remove).toBeNull();
    const managed = entry("managed:claude", { scope: "managed", kind: "managed", readOnly: true });
    const none = actionsFor([managed], 0);
    expect(Object.values(none).every((plan) => plan === null)).toBe(true);
  });

  it("offers nothing to change on a file that isn't there yet", () => {
    const missing = projectAgents({}, { exists: false });
    expect(Object.values(actionsFor([missing], 0)).every((plan) => plan === null)).toBe(true);
  });
});

describe("what Claude does once CLAUDE.md is gone", () => {
  const claudeMd = projectClaude("CLAUDE.md");
  const plans = (
    others: InstructionEntry[],
    choices: ClaudeInstructionChoice[],
    list = [projectAgents(), claudeMd, ...others],
    context = ctx,
  ) => {
    const all = data(list, choices);
    const row = findInstructionRow(all, context, claudeMd.id)!;
    const actions = instructionActions(row, context, all);
    return { share: actions.share!.plan, remove: actions.remove! };
  };

  it("leaves Claude alone when it would read AGENTS.md anyway", () => {
    for (const value of ["claude-md-or-agents-md", "claude-md-and-agents-md"] as const) {
      const { share, remove } = plans([], [choice("claudeAgent", { value })]);
      expect(share.change).toMatchObject({ claude: [] });
      expect(share.confirmation!.body).toBe(
        "Its text goes at the end of AGENTS.md, then CLAUDE.md is deleted. Every agent reads AGENTS.md from then on.",
      );
      expect(remove.confirmation!.body).toBe("Claude reads AGENTS.md instead.");
    }
  });

  it("turns Claude on for AGENTS.md when a local file keeps it away under the default", () => {
    const { share, remove } = plans([projectClaude("CLAUDE.local.md")], [choice("claudeAgent")]);
    expect(share.change).toMatchObject({ kind: "share", claude: ["claudeAgent"] });
    expect(share.confirmation!.body).toBe(
      "Its text goes at the end of AGENTS.md, then CLAUDE.md is deleted.\n\nClaude skips AGENTS.md when there's a CLAUDE.local.md, so this also turns AGENTS.md on for Claude in every project.",
    );
    // The delete says nothing about reading AGENTS.md instead, since Claude wouldn't.
    expect(remove.confirmation!.body).toBe("This deletes CLAUDE.md.");
    expect(
      plans([projectClaude(".claude/CLAUDE.md")], [choice("claudeAgent")]).share.confirmation!.body,
    ).toContain("when there's a .claude/CLAUDE.md,");
  });

  it("turns Claude on when it is set to never read AGENTS.md", () => {
    const { share, remove } = plans(
      [],
      [choice("claudeAgent", { value: "claude-md", explicit: true })],
    );
    expect(share.change).toMatchObject({ claude: ["claudeAgent"] });
    expect(share.confirmation!.body).toBe(
      "Its text goes at the end of AGENTS.md, then CLAUDE.md is deleted.\n\nClaude is set to never read AGENTS.md, so this also turns it on for Claude in every project.",
    );
    expect(remove.confirmation!.body).toBe("This deletes CLAUDE.md.");
  });

  it("says in the move too, after the line on who gets the instructions", () => {
    const noAgents = projectAgents({}, { exists: false });
    const { share } = plans(
      [projectClaude("CLAUDE.local.md")],
      [choice("claudeAgent")],
      [noAgents, claudeMd, projectClaude("CLAUDE.local.md")],
    );
    expect(share.confirmation!.body).toBe(
      "Every agent reads AGENTS.md, so Codex and Pi get these instructions too.\n\nClaude skips AGENTS.md when there's a CLAUDE.local.md, so this also turns AGENTS.md on for Claude in every project.",
    );
  });

  it("changes nothing for a Claude that is too old, or that the organization decides", () => {
    const old = plans([], [choice("claudeAgent", { supported: false, version: "2.0.1" })]);
    expect(old.share.change).toMatchObject({ claude: [] });
    expect(old.share.confirmation!.body).toBe(
      "Its text goes at the end of AGENTS.md, then CLAUDE.md is deleted. Every agent reads AGENTS.md from then on.\n\nClaude Code needs version 2.1.277 or later to read AGENTS.md.",
    );
    expect(old.remove.confirmation!.body).toBe("This deletes CLAUDE.md.");
    const managed = plans([], [choice("claudeAgent", { value: "managed-only" })]);
    expect(managed.share.change).toMatchObject({ claude: [] });
    expect(managed.share.confirmation!.body).toContain(
      "\n\nYour organization decides whether Claude reads AGENTS.md.",
    );
    expect(managed.remove.confirmation!.body).toBe("This deletes CLAUDE.md.");
  });

  it("names each Claude instance when there are several", () => {
    const context = { installed: [claude, claudeWork, codex, pi] };
    const local = projectClaude("CLAUDE.local.md");
    const { share } = plans(
      [local],
      [choice("claudeAgent"), choice("claude_work", { supported: false })],
      [projectAgents(), claudeMd, local],
      context,
    );
    expect(share.change).toMatchObject({ claude: ["claudeAgent"] });
    expect(share.confirmation!.body).toContain(
      "Claude skips AGENTS.md when there's a CLAUDE.local.md, so this also turns AGENTS.md on for Claude in every project.",
    );
    expect(share.confirmation!.body).toContain(
      "Claude Work needs Claude Code 2.1.277 or later to read AGENTS.md.",
    );
    // Both skip it, and both are set.
    const both = plans(
      [local],
      [choice("claudeAgent"), choice("claude_work")],
      [projectAgents(), claudeMd, local],
      context,
    );
    expect(both.share.change).toMatchObject({ claude: ["claudeAgent", "claude_work"] });
    expect(both.share.confirmation!.body).toContain(
      "Claude and Claude Work skip AGENTS.md when there's a CLAUDE.local.md, so this also turns AGENTS.md on for Claude and Claude Work in every project.",
    );
  });

  it("says Claude reads AGENTS.md instead only when there is a Claude and an AGENTS.md", () => {
    const noClaude = { installed: [codex, pi] };
    const asked = plans(
      [],
      [],
      [projectAgents(), projectClaude("CLAUDE.md", { codex: { state: "direct" } })],
      noClaude,
    );
    expect(asked.remove.confirmation!.body).toBe("This deletes CLAUDE.md.");
    const two = plans(
      [],
      [choice("claudeAgent"), choice("claude_work")],
      [projectAgents(), claudeMd],
      { installed: [claude, claudeWork, codex, pi] },
    );
    expect(two.remove.confirmation!.body).toBe("Claude and Claude Work read AGENTS.md instead.");
    // With no AGENTS.md to take over, the delete is just a delete.
    const noAgents = plans(
      [],
      [choice("claudeAgent")],
      [projectAgents({}, { exists: false }), claudeMd],
    );
    expect(noAgents.remove.confirmation!.body).toBe("This deletes CLAUDE.md.");
  });
});

describe("asking git", () => {
  const share = planClaudeAgents([ProviderInstanceId.make("claudeAgent")], ctx);
  const claudeMd = projectClaude("CLAUDE.md");
  const planFor = (
    list: InstructionEntry[],
    pick: "share" | "remove",
    choices = [choice("claudeAgent")],
  ) => {
    const all = data(list, choices);
    const row = findInstructionRow(all, ctx, claudeMd.id)!;
    const actions = instructionActions(row, ctx, all);
    return pick === "share" ? actions.share!.plan : actions.remove!;
  };
  const noAgents = projectAgents({}, { exists: false });
  const move = planFor([noAgents, claudeMd], "share");
  const merge = planFor([projectAgents(), claudeMd], "share");
  const del = planFor([claudeMd], "remove");

  it("checks the project files a move, merge or delete is about to touch, and nothing else", () => {
    expect(instructionsToCheckWithGit(del)).toEqual(["project:claude:CLAUDE.md"]);
    expect(instructionsToCheckWithGit(move)).toEqual(["project:claude:CLAUDE.md"]);
    expect(instructionsToCheckWithGit(merge)).toEqual([
      "project:claude:CLAUDE.md",
      "project:shared:AGENTS.md",
    ]);
    expect(instructionsToCheckWithGit(share)).toBeNull();
    const global = instructionActions(
      findInstructionRow(data([ownFile("codex")]), ctx, "global:agentOwn:codex")!,
      ctx,
      data([ownFile("codex")]),
    ).remove!;
    expect(instructionsToCheckWithGit(global)).toBeNull();
  });

  it("says git can undo a delete only for a file git tracks, replacing the line that says it can't", () => {
    expect(withInstructionGitNote(del, []).confirmation!.notes).toEqual(["This can't be undone."]);
    expect(withInstructionGitNote(del, ["other"]).confirmation!.notes).toEqual([
      "This can't be undone.",
    ]);
    expect(withInstructionGitNote(del, ["project:claude:CLAUDE.md"]).confirmation!.notes).toEqual([
      "You can undo this with git.",
    ]);
  });

  it("adds the line to a move when the file is tracked", () => {
    expect(withInstructionGitNote(move, ["project:claude:CLAUDE.md"]).confirmation!.notes).toEqual([
      "You can undo this with git.",
    ]);
    expect(withInstructionGitNote(move, []).confirmation!.notes).toEqual([]);
  });

  it("adds the line to a merge only when both files are tracked", () => {
    const claudeFile = "project:claude:CLAUDE.md";
    const agentsFile = "project:shared:AGENTS.md";
    expect(withInstructionGitNote(merge, [claudeFile, agentsFile]).confirmation!.notes).toEqual([
      "You can undo this with git.",
    ]);
    expect(withInstructionGitNote(merge, [claudeFile]).confirmation!.notes).toEqual([]);
    expect(withInstructionGitNote(merge, [agentsFile]).confirmation!.notes).toEqual([]);
    expect(withInstructionGitNote(merge, []).confirmation!.notes).toEqual([]);
  });

  it("limits the line to the file change when the same plan also sets Claude", () => {
    const local = projectClaude("CLAUDE.local.md");
    const alsoSets = planFor([projectAgents(), claudeMd, local], "share");
    expect(alsoSets.change).toMatchObject({ claude: ["claudeAgent"] });
    expect(
      withInstructionGitNote(alsoSets, ["project:claude:CLAUDE.md", "project:shared:AGENTS.md"])
        .confirmation!.notes,
    ).toEqual(["You can undo the file change with git."]);
    const moveAlsoSets = planFor([noAgents, claudeMd, local], "share");
    expect(
      withInstructionGitNote(moveAlsoSets, ["project:claude:CLAUDE.md"]).confirmation!.notes,
    ).toEqual(["You can undo the file change with git."]);
  });
});

describe("search", () => {
  const rows = rowsFor([
    projectAgents(),
    sharedFile(),
    projectClaude("CLAUDE.md"),
    projectClaude("CLAUDE.local.md"),
  ]);
  const [project, claudeMd, local, shared] = rows;

  it("matches a row by its file name and its group", () => {
    expect(matchesInstructionQuery(project!, "agents.md")).toBe(true);
    expect(matchesInstructionQuery(project!, "project")).toBe(true);
    expect(matchesInstructionQuery(project!, "global")).toBe(false);
    expect(matchesInstructionQuery(shared!, "global")).toBe(true);
    expect(matchesInstructionQuery(claudeMd!, "claude.md")).toBe(true);
    expect(matchesInstructionQuery(claudeMd!, "agents.md")).toBe(false);
    expect(matchesInstructionQuery(local!, "claude.local.md")).toBe(true);
    expect(matchesInstructionQuery(project!, "")).toBe(true);
  });

  it("matches Claude's choice by the words on its row", () => {
    const [row] = claudeRows([choice("claudeAgent")], ctx);
    expect(matchesClaudeQuery(row!, "agents.md")).toBe(true);
    expect(matchesClaudeQuery(row!, "claude")).toBe(true);
    expect(matchesClaudeQuery(row!, "tdd")).toBe(false);
  });
});

describe("saying what happened", () => {
  it("reads the reason from the server's error, and nothing else", () => {
    expect(instructionErrorReason({ _tag: "InstructionError", reason: "changedOnDisk" })).toBe(
      "changedOnDisk",
    );
    expect(instructionErrorReason({ _tag: "SomethingElse", reason: "changedOnDisk" })).toBeNull();
    expect(instructionErrorReason(new Error("boom"))).toBeNull();
    expect(instructionErrorReason(null)).toBeNull();
    expect(instructionErrorReason("changedOnDisk")).toBeNull();
  });

  it("treats a file that changed, or appeared, as the person's call, not a failure", () => {
    expect(isSaveConflict("changedOnDisk")).toBe(true);
    expect(isSaveConflict("exists")).toBe(true);
    expect(isSaveConflict("readOnly")).toBe(false);
    expect(isSaveConflict(null)).toBe(false);
  });

  it("words each reason the server can give", () => {
    expect(failureText(null)).toBe("Couldn't change the instructions here.");
    expect(failureText("invalidSettings")).toBe(
      "Claude's settings file isn't valid JSON, so T3 Code left it alone.",
    );
    expect(failureText("linkFailed")).toBe(
      "Couldn't make the link. On Windows, turn on Developer Mode.",
    );
    expect(failureText("writeFailed")).toBe("Couldn't change that file.");
  });

  it("says who was turned on or off, and who couldn't be", () => {
    const result = (outcome: "changed" | "unchanged" | "failed", id: string, reason?: string) => ({
      instanceId: ProviderInstanceId.make(id),
      outcome,
      ...(reason ? { reason } : {}),
    });
    expect(
      describeAgentsResult("enable", [result("changed", "codex"), result("changed", "pi")], ctx),
    ).toBe("Turned on for Codex and Pi.");
    expect(describeAgentsResult("disable", [result("changed", "codex")], ctx)).toBe(
      "Turned off for Codex.",
    );
    expect(
      describeAgentsResult(
        "enable",
        [result("changed", "codex"), result("failed", "pi", "It keeps its own file.")],
        ctx,
      ),
    ).toBe("Turned on for Codex. Couldn't change Pi: It keeps its own file.");
    expect(describeAgentsResult("enable", [result("failed", "pi")], ctx)).toBe(
      "Couldn't change Pi.",
    );
    expect(describeAgentsResult("enable", [result("unchanged", "pi")], ctx)).toBe("Already on.");
    expect(describeAgentsResult("disable", [], ctx)).toBe("Already off.");
  });

  it("says what the other changes did", () => {
    const id = ProviderInstanceId.make("claudeAgent");
    expect(
      describeChange({ kind: "setClaude", instances: [id], value: "claude-md-and-agents-md" }, ctx),
    ).toBe("Claude now reads AGENTS.md in every project.");
    expect(describeChange({ kind: "setClaude", instances: [id], value: "claude-md" }, ctx)).toBe(
      "Claude no longer reads AGENTS.md.",
    );
    expect(describeChange({ kind: "setClaude", instances: [id], value: null }, ctx)).toBe(
      "Claude follows its default again.",
    );
    expect(describeChange({ kind: "adopt", ids: ["x"], names: ["Codex"] }, ctx)).toBe(
      "Codex now uses your Global instructions.",
    );
    expect(describeChange({ kind: "adopt", ids: ["x", "y"], names: ["Codex", "Pi"] }, ctx)).toBe(
      "Codex and Pi now use your Global instructions.",
    );
    const share = { kind: "share", id: "x", project: true, merge: false, claude: [] } as const;
    expect(describeChange(share, ctx)).toBe("CLAUDE.md is now AGENTS.md.");
    expect(describeChange({ ...share, merge: true }, ctx)).toBe("Merged CLAUDE.md into AGENTS.md.");
    expect(describeChange({ ...share, merge: true, claude: [id] }, ctx)).toBe(
      "Merged CLAUDE.md into AGENTS.md. Claude now reads AGENTS.md in every project.",
    );
    expect(describeChange({ ...share, claude: [id] }, ctx)).toBe(
      "CLAUDE.md is now AGENTS.md. Claude now reads AGENTS.md in every project.",
    );
    expect(describeChange({ kind: "delete", id: "x", name: "CLAUDE.md", project: true }, ctx)).toBe(
      "Deleted CLAUDE.md.",
    );
  });

  it("names the files that couldn't be read, briefly", () => {
    const files = (...paths: string[]) => paths.map((path) => ({ path }));
    expect(instructionUnreadableNote([])).toBe("");
    expect(instructionUnreadableNote(files("/a/AGENTS.md"))).toBe("Couldn't read /a/AGENTS.md");
    expect(instructionUnreadableNote(files("/a", "/b"))).toBe("Couldn't read /a and /b");
    expect(instructionUnreadableNote(files("/a", "/b", "/c", "/d"))).toBe(
      "Couldn't read /a, /b and 2 more",
    );
  });
});
