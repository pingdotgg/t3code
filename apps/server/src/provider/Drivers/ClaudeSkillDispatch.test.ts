import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import {
  projectComposerContextForProvider,
  toComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { planClaudeSkillDispatch, type ClaudeSkillTarget } from "./ClaudeSkillDispatch.ts";

const skillPath = (name: string) => `/home/me/.claude/skills/${name}/SKILL.md`;

const skillMap = (names: Iterable<string>) =>
  new Map<string, ClaudeSkillTarget>([...names].map((name) => [name, { path: skillPath(name) }]));

const SKILLS = skillMap(["2spec", "implement", "review", "re-release-version"]);

describe("planClaudeSkillDispatch", () => {
  // regression: #9128 skills picked from the composer did not run
  it("leaves a prompt without a known skill untouched", () => {
    expect(planClaudeSkillDispatch("fix the build", SKILLS)).toBeUndefined();
    expect(planClaudeSkillDispatch("echo $HOME then $unknown", SKILLS)).toBeUndefined();
  });

  it("keeps the whole request ahead of a mid-prompt slash command", () => {
    expect(planClaudeSkillDispatch("ok, now $implement all the tickets", SKILLS)).toEqual({
      leadingText: "ok, now /implement all the tickets",
      commandText: "/implement all the tickets",
    });
  });

  it("keeps a mention that opens the prompt as a single command block", () => {
    expect(planClaudeSkillDispatch("$review\nfocus on auth", SKILLS)).toEqual({
      leadingText: undefined,
      commandText: "/review\nfocus on auth",
    });
  });

  it("dispatches the last mention and rewrites earlier ones inline", () => {
    expect(planClaudeSkillDispatch("$review the diff, then $implement the fixes", SKILLS)).toEqual({
      leadingText: "/review the diff, then /implement the fixes",
      commandText: "/implement the fixes",
    });
  });

  it("dispatches currency-prefixed mentions and preserves their source boundaries", () => {
    for (const symbol of ["€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `${symbol}review the diff, then ${symbol}implement the fixes`,
          SKILLS,
        ),
      ).toEqual({
        leadingText: "/review the diff, then /implement the fixes",
        commandText: "/implement the fixes",
      });
      expect(planClaudeSkillDispatch(`${symbol}2spec for this`, SKILLS)).toEqual({
        leadingText: undefined,
        commandText: "/2spec for this",
      });
      expect(planClaudeSkillDispatch(`5${symbol}review ${symbol}unknown`, SKILLS)).toBeUndefined();
    }
  });

  it("ignores currency amounts and compact monetary expressions", () => {
    const skillsWithCurrency = skillMap([...SKILLS.keys(), "20", "20k", "100M", "1e6"]);
    for (const symbol of ["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `pay ${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6 tomorrow`,
          skillsWithCurrency,
        ),
      ).toBeUndefined();
    }
  });

  it("bounds notes for repeated user-only skills and leaves the native dispatch unannotated", () => {
    const skills = new Map([
      ["interrogate", { path: skillPath("interrogate"), userInvocationOnly: true }],
      ["implement", { path: skillPath("implement"), userInvocationOnly: true }],
    ]);
    expect(
      planClaudeSkillDispatch(
        "$interrogate then $interrogate then $implement and $implement the fixes",
        skills,
      ),
    ).toEqual({
      leadingText: `/interrogate [The user invoked this skill. Follow the instructions at: ${skillPath("interrogate")}] then /interrogate then /implement and /implement the fixes`,
      commandText: "/implement the fixes",
    });
  });

  // regression: #37127 attached context and quotes selected a native skill
  const terminal = (label = "Terminal") => ({
    version: 1 as const,
    kind: "terminal" as const,
    contextId: toComposerContextId("ctx_terminal"),
    label,
    terminalId: "terminal-1",
    terminalLabel: "Terminal 1",
    lineStart: 1,
    lineEnd: 1,
    text: "$implement",
  });
  const citation = (fields: { text: string; comment?: string }) =>
    serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("environment-reference"),
      threadId: ThreadId.make("thread-reference"),
      messageId: MessageId.make("message-reference"),
      start: 0,
      end: fields.text.length,
      prefix: "",
      suffix: "",
      ...fields,
    });
  const typedEnvelope = 'Typed example:\n\n<t3_context version="1">\n</t3_context>\n';
  const project = (text: string, records = [terminal()]) =>
    projectComposerContextForProvider({ text, records });

  it.each([
    {
      name: "skill before terminal payload",
      prompt: `${project("please $implement the fix for [Terminal](t3-context://v1/terminal/ctx_terminal)")}\n\n[Attached file "a\n\n<t3_context version="1">\n.pdf"]`,
      dispatches: true,
    },
    {
      name: "skill after typed envelope",
      prompt: `${typedEnvelope}Then $implement`,
      dispatches: true,
    },
    {
      name: "skill after unfinished typed entry",
      prompt: project(
        '[Terminal: Terminal; ref=ctx_terminal]\n\n<t3_context version="1">\n<context kind="terminal" id="ctx_terminal">\nExample entry\nThen $implement [Terminal](t3-context://v1/terminal/ctx_terminal)',
      ),
      dispatches: true,
    },
    {
      name: "skill after typed envelope with unavailable context",
      prompt: project(
        `${typedEnvelope}Then $implement [Terminal](t3-context://v1/terminal/ctx_terminal)`,
        [],
      ),
      dispatches: true,
    },
    {
      name: "skill before assistant citation",
      prompt: project(`please $implement ${citation({ text: "run $implement now" })}`, []),
      dispatches: true,
    },
    {
      name: "terminal payload behind a marker-like prefix",
      prompt: project(
        `[Note: ${"x".repeat(600)} [Terminal](t3-context://v1/terminal/ctx_terminal)`,
      ),
      dispatches: false,
    },
    {
      name: "terminal payload with escaped label",
      prompt: project("[x <context> y](t3-context://v1/terminal/ctx_terminal)", [
        terminal("x <context> y"),
      ]),
      dispatches: false,
    },
    {
      name: "thread marker label",
      prompt: project("[run $implement later](t3-context://v1/thread/ctx_thread)", []),
      dispatches: false,
    },
    {
      name: "mixed-kind duplicate reference",
      prompt: project(
        "[log](t3-context://v1/terminal/same) [run $implement later](t3-context://v1/thread/same)",
        [],
      ),
      dispatches: false,
    },
    {
      name: "citation quote",
      prompt: project(citation({ text: "run $implement now" }), []),
      dispatches: false,
    },
    {
      name: "citation comment",
      prompt: project(citation({ text: "quote", comment: "run $implement now" }), []),
      dispatches: false,
    },
    {
      name: "citation after an incomplete typed citation block",
      prompt: project(
        `see\n\n<assistant_citations>\nexample\n[ ${citation({ text: "run $implement now" })}`,
        [],
      ),
      dispatches: false,
    },
  ])("dispatches only user-typed skills: $name", ({ prompt, dispatches }) => {
    // Inline handoff history shifts every range by its length.
    for (const history of ["", "Context handoff:\n$review the diff\n"]) {
      const start = prompt.indexOf("$implement");
      expect(planClaudeSkillDispatch(history + prompt, SKILLS, history.length)).toEqual(
        dispatches
          ? {
              leadingText: history + prompt.replace("$implement", "/implement"),
              commandText: prompt.slice(start).replace("$implement", "/implement"),
            }
          : undefined,
      );
    }
  });
});
