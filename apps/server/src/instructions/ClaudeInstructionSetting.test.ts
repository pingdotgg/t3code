import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  addAgentsMdImport,
  agentsMdImportLine,
  claudeInstructionChanges,
  hasAgentsMdImport,
  parseSettingsJson,
  readClaudeInstructionSetting,
  removeAgentsMdImport,
  supportsAgentsMd,
} from "./ClaudeInstructionSetting.ts";
import { editJsoncText } from "../skills/JsoncSettings.ts";

const NEW_ID = "cc-plugin-agents-md@builtin";
const LEGACY_ID = "agents-md@builtin";

const entry = (value: unknown, extra: Record<string, unknown> = {}) => ({
  options: { instructionFiles: value, ...extra },
});

describe("settings.json text", () => {
  it.each(["", "{", "null", "[]", "3", '"text"'])("is not a settings object: %j", (text) => {
    expect(parseSettingsJson(text)).toBeUndefined();
  });

  it("parses an object, comments and trailing commas included", () => {
    expect(parseSettingsJson('{"theme":"dark","list":[1,2]}')).toEqual({
      theme: "dark",
      list: [1, 2],
    });
    expect(parseSettingsJson('{\n  // a note\n  "theme": "dark",\n}')).toEqual({ theme: "dark" });
  });
});

describe("readClaudeInstructionSetting", () => {
  const cases: Array<[string, unknown, string, boolean]> = [
    ["no settings", undefined, "claude-md-or-agents-md", false],
    ["not an object", [], "claude-md-or-agents-md", false],
    ["empty object", {}, "claude-md-or-agents-md", false],
    ["pluginConfigs of the wrong type", { pluginConfigs: "x" }, "claude-md-or-agents-md", false],
    ["current id", { pluginConfigs: { [NEW_ID]: entry("claude-md") } }, "claude-md", true],
    [
      "legacy id only",
      { pluginConfigs: { [LEGACY_ID]: entry("claude-md-and-agents-md") } },
      "claude-md-and-agents-md",
      true,
    ],
    [
      "both ids, current wins",
      { pluginConfigs: { [NEW_ID]: entry("managed-only"), [LEGACY_ID]: entry("claude-md") } },
      "managed-only",
      true,
    ],
    [
      "unknown value in the current id, legacy is valid",
      { pluginConfigs: { [NEW_ID]: entry("nonsense"), [LEGACY_ID]: entry("claude-md") } },
      "claude-md",
      true,
    ],
    [
      "unknown value only",
      { pluginConfigs: { [NEW_ID]: entry("nonsense") } },
      "claude-md-or-agents-md",
      false,
    ],
    [
      "value of the wrong type",
      { pluginConfigs: { [NEW_ID]: entry(3) } },
      "claude-md-or-agents-md",
      false,
    ],
  ];

  it.each(cases)("%s", (_name, settings, value, explicit) => {
    expect(readClaudeInstructionSetting(settings)).toEqual({ value, explicit });
  });
});

/** The settings after the shared editor makes the changes, `undefined` when it refuses. */
const withClaudeInstructionSetting = (
  settings: Record<string, unknown>,
  value: Parameters<typeof claudeInstructionChanges>[1],
) => {
  const text = JSON.stringify(settings, null, 2);
  const edited = editJsoncText(text, claudeInstructionChanges(settings, value));
  return edited === undefined ? undefined : parseSettingsJson(edited);
};

describe("claudeInstructionChanges", () => {
  it("creates the nested objects in empty settings", () => {
    expect(withClaudeInstructionSetting({}, "claude-md-and-agents-md")).toEqual({
      pluginConfigs: { [NEW_ID]: entry("claude-md-and-agents-md") },
    });
  });

  it("keeps other keys at every level, and their order", () => {
    const settings = {
      theme: "dark",
      pluginConfigs: {
        "other@marketplace": { enabled: true },
        [NEW_ID]: { enabled: true, options: { other: 1, instructionFiles: "claude-md" } },
      },
      hooks: {},
    };
    const updated = withClaudeInstructionSetting(settings, "managed-only");
    expect(updated).toEqual({
      theme: "dark",
      pluginConfigs: {
        "other@marketplace": { enabled: true },
        [NEW_ID]: { enabled: true, options: { other: 1, instructionFiles: "managed-only" } },
      },
      hooks: {},
    });
    expect(Object.keys(updated ?? {})).toEqual(["theme", "pluginConfigs", "hooks"]);
  });

  it("keeps the comments of a file it edits", () => {
    const text = '{\n  // my theme\n  "theme": "dark"\n}\n';
    const edited = editJsoncText(
      text,
      claudeInstructionChanges(parseSettingsJson(text) ?? {}, "claude-md"),
    );
    expect(edited).toContain("// my theme");
    expect(parseSettingsJson(edited ?? "")).toEqual({
      theme: "dark",
      pluginConfigs: { [NEW_ID]: entry("claude-md") },
    });
  });

  it("updates a legacy entry that has a value, and leaves one that has none", () => {
    expect(
      withClaudeInstructionSetting(
        { pluginConfigs: { [LEGACY_ID]: entry("claude-md") } },
        "claude-md-and-agents-md",
      ),
    ).toEqual({
      pluginConfigs: {
        [LEGACY_ID]: entry("claude-md-and-agents-md"),
        [NEW_ID]: entry("claude-md-and-agents-md"),
      },
    });
    const withoutValue = { pluginConfigs: { [LEGACY_ID]: { options: { other: true } } } };
    expect(withClaudeInstructionSetting(withoutValue, "claude-md")).toEqual({
      pluginConfigs: { [LEGACY_ID]: { options: { other: true } }, [NEW_ID]: entry("claude-md") },
    });
  });

  it("removes the entry, then every object that it leaves empty", () => {
    expect(
      withClaudeInstructionSetting({ pluginConfigs: { [NEW_ID]: entry("claude-md") } }, null),
    ).toEqual({});
    expect(
      withClaudeInstructionSetting(
        { theme: "dark", pluginConfigs: { [NEW_ID]: entry("claude-md") } },
        null,
      ),
    ).toEqual({ theme: "dark" });
  });

  it("stops cleaning up at the first object that still has something in it", () => {
    expect(
      withClaudeInstructionSetting(
        { pluginConfigs: { [NEW_ID]: entry("claude-md", { other: 1 }) } },
        null,
      ),
    ).toEqual({ pluginConfigs: { [NEW_ID]: { options: { other: 1 } } } });
    expect(
      withClaudeInstructionSetting(
        { pluginConfigs: { [NEW_ID]: { enabled: true, ...entry("claude-md") } } },
        null,
      ),
    ).toEqual({ pluginConfigs: { [NEW_ID]: { enabled: true } } });
    expect(
      withClaudeInstructionSetting(
        { pluginConfigs: { "other@marketplace": {}, [NEW_ID]: entry("claude-md") } },
        null,
      ),
    ).toEqual({ pluginConfigs: { "other@marketplace": {} } });
  });

  it("removes a legacy entry together with the current one", () => {
    const updated = withClaudeInstructionSetting(
      {
        pluginConfigs: { [NEW_ID]: entry("claude-md"), [LEGACY_ID]: entry("claude-md") },
        theme: "dark",
      },
      null,
    );
    expect(updated).toEqual({ theme: "dark" });
    expect(readClaudeInstructionSetting(updated)).toEqual({
      value: "claude-md-or-agents-md",
      explicit: false,
    });
  });

  it("has nothing to change when there is nothing to remove", () => {
    expect(claudeInstructionChanges({ pluginConfigs: {}, theme: "dark" }, null)).toEqual([]);
  });

  it("refuses to overwrite a value that isn't an object, and leaves it alone on removal", () => {
    for (const settings of [
      { pluginConfigs: "x" },
      { pluginConfigs: [] },
      { pluginConfigs: { [NEW_ID]: true } },
      { pluginConfigs: { [NEW_ID]: { options: "x" } } },
    ]) {
      expect(withClaudeInstructionSetting(settings, "claude-md")).toBeUndefined();
      expect(withClaudeInstructionSetting(settings, null)).toEqual(settings);
    }
  });

  it("reads back what it writes", () => {
    const written = withClaudeInstructionSetting({}, "claude-md");
    expect(readClaudeInstructionSetting(written)).toEqual({ value: "claude-md", explicit: true });
  });
});

describe("supportsAgentsMd", () => {
  const cases: Array<[string | null | undefined, boolean]> = [
    ["2.1.277", true],
    ["2.1.276", false],
    ["2.1.291", true],
    ["2.2.0", true],
    ["3.0.0", true],
    ["2.0.999", false],
    ["1.9.9", false],
    ["v2.1.277", true],
    ["  2.1.291  ", true],
    ["2.1.291 (Claude Code)", true],
    ["2.1.277+build.5", true],
    ["2.1.277-beta.1", false],
    ["2.1.278-beta.1", true],
    ["2.1", false],
    ["2", false],
    ["", false],
    ["   ", false],
    ["latest", false],
    ["2.1.x", false],
    ["(Claude Code)", false],
    [null, false],
    [undefined, false],
  ];

  it.each(cases)("%j", (version, expected) => {
    expect(supportsAgentsMd(version)).toBe(expected);
  });
});

/** The two kinds of AGENTS.md that a CLAUDE.md imports, on the platform the layer provides. */
const targets = Effect.gen(function* () {
  const path = yield* Path.Path;
  return {
    /** The shared file in the home directory, imported from Claude's own CLAUDE.md. */
    shared: {
      path,
      agentsMdPath: "/home/user/.agents/AGENTS.md",
      claudeMdDirectory: "/home/user/.claude",
      homeDirectory: "/home/user",
    },
    /** A project's AGENTS.md, imported from the CLAUDE.md next to it. */
    project: {
      path,
      agentsMdPath: "/work/acme-web/AGENTS.md",
      claudeMdDirectory: "/work/acme-web",
      homeDirectory: "/home/user",
    },
    sharedWithSpace: {
      path,
      agentsMdPath: "/home/user/My Notes/AGENTS.md",
      claudeMdDirectory: "/home/user/.claude",
      homeDirectory: "/home/user",
    },
  };
});

type TargetName = "shared" | "project" | "sharedWithSpace";

it.layer(NodePath.layerPosix, { excludeTestServices: true })("AGENTS.md imports", (it) => {
  describe("agentsMdImportLine", () => {
    const cases: Array<[TargetName | { agentsMdPath: string }, string]> = [
      ["shared", "@~/.agents/AGENTS.md"],
      ["project", "@/work/acme-web/AGENTS.md"],
      ["sharedWithSpace", "@~/My\\ Notes/AGENTS.md"],
      [{ agentsMdPath: "/home/username/AGENTS.md" }, "@/home/username/AGENTS.md"],
      [{ agentsMdPath: "/home/user/..cache/AGENTS.md" }, "@~/..cache/AGENTS.md"],
    ];

    it.effect.each(cases)("%#", ([which, line]) =>
      Effect.gen(function* () {
        const all = yield* targets;
        const target =
          typeof which === "string"
            ? all[which]
            : { ...all.shared, agentsMdPath: which.agentsMdPath };
        expect(agentsMdImportLine(target)).toBe(line);
      }),
    );
  });

  describe("hasAgentsMdImport", () => {
    const cases: Array<[string, TargetName, string, boolean]> = [
      ["home form", "shared", "@~/.agents/AGENTS.md", true],
      ["absolute", "shared", "@/home/user/.agents/AGENTS.md", true],
      ["relative with dots", "shared", "@../.agents/AGENTS.md", true],
      ["same folder", "project", "@AGENTS.md", true],
      ["same folder with ./", "project", "@./AGENTS.md", true],
      ["roundabout", "project", "@../acme-web/AGENTS.md", true],
      ["indented and padded", "project", "   @AGENTS.md   ", true],
      ["escaped space", "sharedWithSpace", "@~/My\\ Notes/AGENTS.md", true],
      ["another file", "project", "@docs/AGENTS.md", false],
      ["relative to the wrong folder", "shared", "@AGENTS.md", false],
      ["another home", "shared", "@~/other/AGENTS.md", false],
      ["unescaped space", "sharedWithSpace", "@~/My Notes/AGENTS.md", false],
      ["mentioned in a sentence", "project", "See @AGENTS.md for more", false],
      ["text after the path", "project", "@AGENTS.md please", false],
      ["not at the start of the line", "project", "- @AGENTS.md", false],
      ["quoted", "project", '@"AGENTS.md"', false],
      ["bare at sign", "project", "@", false],
      ["no at sign", "project", "AGENTS.md", false],
    ];

    it.effect.each(cases)("%s", ([, which, text, expected]) =>
      Effect.gen(function* () {
        expect(hasAgentsMdImport(text, (yield* targets)[which])).toBe(expected);
      }),
    );

    it.effect("finds the import anywhere in the text, not only on the first line", () =>
      Effect.gen(function* () {
        const { project } = yield* targets;
        expect(hasAgentsMdImport("# Notes\n\n@AGENTS.md\nmore\n", project)).toBe(true);
      }),
    );

    it.effect("ignores lines inside fenced code blocks", () =>
      Effect.gen(function* () {
        const { project } = yield* targets;
        expect(hasAgentsMdImport("```\n@AGENTS.md\n```\n", project)).toBe(false);
        expect(hasAgentsMdImport("~~~md\n@AGENTS.md\n~~~\n", project)).toBe(false);
        expect(hasAgentsMdImport("````\n```\n@AGENTS.md\n```\n````\n", project)).toBe(false);
        expect(hasAgentsMdImport("```\ncode\n```\n@AGENTS.md\n", project)).toBe(true);
      }),
    );

    it.effect("treats an unclosed fence as running to the end of the text", () =>
      Effect.gen(function* () {
        const { project } = yield* targets;
        expect(hasAgentsMdImport("```\n@AGENTS.md\n", project)).toBe(false);
      }),
    );
  });

  describe("addAgentsMdImport", () => {
    const line = "@~/.agents/AGENTS.md";
    const cases: Array<[string, string, string]> = [
      ["empty text", "", `${line}\n`],
      ["one line, no line ending", "# Notes", `${line}\n# Notes`],
      ["text with a trailing newline", "# Notes\n", `${line}\n# Notes\n`],
      ["CRLF text", "# Notes\r\nmore\r\n", `${line}\r\n# Notes\r\nmore\r\n`],
      ["leading blank lines", "\n\n# Notes\n", `${line}\n\n\n# Notes\n`],
      ["leading blank CRLF lines", "\r\n# Notes\r\n", `${line}\r\n\r\n# Notes\r\n`],
      ["other @ lines", "@README.md\n@docs/guide.md\n", `${line}\n@README.md\n@docs/guide.md\n`],
      ["a byte order mark", "\uFEFF# Notes\n", `\uFEFF${line}\n# Notes\n`],
    ];

    it.effect.each(cases)("%s", ([, text, expected]) =>
      Effect.gen(function* () {
        const { shared } = yield* targets;
        expect(addAgentsMdImport(text, shared)).toBe(expected);
      }),
    );

    it.effect("leaves text that already imports the file as it is, wherever the import is", () =>
      Effect.gen(function* () {
        const { shared } = yield* targets;
        for (const text of [
          `${line}\n# Notes\n`,
          `# Notes\n${line}\n`,
          "@../.agents/AGENTS.md\n",
          `\n${line}`,
        ]) {
          expect(addAgentsMdImport(text, shared)).toBe(text);
        }
      }),
    );

    it.effect("adds the import when the only mention is inside a code block", () =>
      Effect.gen(function* () {
        const { shared } = yield* targets;
        expect(addAgentsMdImport("```\n@~/.agents/AGENTS.md\n```\n", shared)).toBe(
          `${line}\n\`\`\`\n@~/.agents/AGENTS.md\n\`\`\`\n`,
        );
      }),
    );
  });

  describe("removeAgentsMdImport", () => {
    const line = "@~/.agents/AGENTS.md";
    const cases: Array<[string, string, string]> = [
      ["only the import", `${line}\n`, ""],
      ["the import and no line ending", line, ""],
      ["first line", `${line}\n# Notes\n`, "# Notes\n"],
      ["middle line", `# Notes\n${line}\nmore\n`, "# Notes\nmore\n"],
      ["last line", `# Notes\n${line}`, "# Notes\n"],
      ["CRLF text", `${line}\r\n# Notes\r\nmore\r\n`, "# Notes\r\nmore\r\n"],
      ["written another way", "@../.agents/AGENTS.md\n# Notes\n", "# Notes\n"],
      ["twice", `${line}\n# Notes\n${line}\n`, "# Notes\n"],
      ["other @ lines stay", `${line}\n@README.md\n`, "@README.md\n"],
      ["blank lines stay", `${line}\n\n# Notes\n`, "\n# Notes\n"],
      ["not there", "# Notes\n@README.md\n", "# Notes\n@README.md\n"],
      ["a byte order mark", `\uFEFF${line}\n# Notes\n`, "\uFEFF# Notes\n"],
    ];

    it.effect.each(cases)("%s", ([, text, expected]) =>
      Effect.gen(function* () {
        const { shared } = yield* targets;
        expect(removeAgentsMdImport(text, shared)).toBe(expected);
      }),
    );

    it.effect("leaves a mention inside a code block alone", () =>
      Effect.gen(function* () {
        const { shared } = yield* targets;
        const text = `\`\`\`\n${line}\n\`\`\`\n`;
        expect(removeAgentsMdImport(text, shared)).toBe(text);
      }),
    );

    it.effect.each(["", "# Notes\n", "# Notes", "\n\nA\r\nB\r\n", "@README.md\n"])(
      "undoes an add: %j",
      (text) =>
        Effect.gen(function* () {
          const { shared } = yield* targets;
          expect(removeAgentsMdImport(addAgentsMdImport(text, shared), shared)).toBe(text);
        }),
    );
  });
});

it.layer(NodePath.layerWin32, { excludeTestServices: true })(
  "AGENTS.md imports on Windows",
  (it) => {
    it.effect("writes forward slashes and reads its own paths back", () =>
      Effect.gen(function* () {
        const target = {
          path: yield* Path.Path,
          agentsMdPath: "C:\\Users\\user\\.agents\\AGENTS.md",
          claudeMdDirectory: "C:\\Users\\user\\.claude",
          homeDirectory: "C:\\Users\\user",
        };
        expect(agentsMdImportLine(target)).toBe("@~/.agents/AGENTS.md");
        expect(hasAgentsMdImport("@~/.agents/AGENTS.md\r\n", target)).toBe(true);
        expect(hasAgentsMdImport("@../.agents/AGENTS.md\r\n", target)).toBe(true);
        expect(hasAgentsMdImport("@~/.agents/OTHER.md\r\n", target)).toBe(false);
      }),
    );
  },
);
