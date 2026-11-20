import { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildSlashItems, rankSlashItems, slashMessage, slashQuery } from "./slash";

const command = Schema.decodeUnknownSync(ServerProviderSlashCommand);
const skill = Schema.decodeUnknownSync(ServerProviderSkill);

const commands = [
  command({ name: "compact", input: { hint: "optional summary instructions" } }),
  command({ name: "code-review", description: "Review a pull request" }),
  command({ name: "debug", description: "Find the cause of an issue" }),
  command({ name: "review", description: "Review the current branch" }),
  command({ name: "egm-review", description: "Run the document review" }),
  command({ name: "security-audit" }),
];

const skills = [
  skill({ name: "review-agent", path: "/s/review-agent", enabled: true, scope: "user" }),
  skill({
    name: "pr-description",
    path: "/s/pr-description",
    enabled: true,
    description: "Draft the review text for a pull request",
  }),
  skill({ name: "security-audit", path: "/s/security-audit", enabled: true }),
  skill({ name: "hidden-skill", path: "/s/hidden", enabled: false }),
  skill({ name: "agent-only", path: "/s/agent-only", enabled: true, userInvocable: false }),
];

const items = buildSlashItems({
  commands,
  skills,
  actions: ["model", "clear"],
  messageIsOnlyTheCommand: true,
});

const labels = (query: string) => rankSlashItems(items, query).map((item) => item.label);

describe("the slash menu's items", () => {
  it("Given a skill that shares a command's name and skills that cannot be invoked, when the items are built, then the command and those skills are left out", () => {
    expect(items.map((item) => item.id)).toEqual([
      "command:compact",
      "command:code-review",
      "command:debug",
      "command:review",
      "command:egm-review",
      "skill:review-agent",
      "skill:pr-description",
      "skill:security-audit",
      "action:model",
      "action:clear",
    ]);
  });

  it("Given text after the command, when the items are built, then /compact is not offered", () => {
    const rest = buildSlashItems({
      commands,
      skills: [],
      actions: [],
      messageIsOnlyTheCommand: false,
    });
    expect(rest.map((item) => item.label)).not.toContain("/compact");
  });

  it("Given T3's /clear and /model are offered, when the items are built, then the provider's own versions are left out", () => {
    const built = buildSlashItems({
      commands: [command({ name: "clear" }), command({ name: "model" }), command({ name: "init" })],
      skills: [],
      actions: ["model", "clear"],
      messageIsOnlyTheCommand: true,
    });
    expect(built.map((item) => [item.group, item.label])).toEqual([
      ["command", "/init"],
      ["action", "/model"],
      ["action", "/clear"],
    ]);
  });
});

describe("ranking the slash menu", () => {
  it("Given the input /, when the items are ranked, then all of them are listed as commands, skills, and T3 actions in the engine's order", () => {
    expect(labels(slashQuery("/", 1) ?? "")).toEqual([
      "/compact",
      "/code-review",
      "/debug",
      "/review",
      "/egm-review",
      "$review-agent",
      "$pr-description",
      "$security-audit",
      "/model",
      "/clear",
    ]);
  });

  it("Given the input /re, when the items are ranked, then prefix matches lead word matches, and each is grouped as commands, skills, and T3 actions", () => {
    expect(labels(slashQuery("/re", 3) ?? "")).toEqual([
      "/review",
      "$review-agent",
      "/code-review",
      "/egm-review",
      "$pr-description",
      "/model",
    ]);
  });

  it("Given the input /rev, when the items are ranked, then the same items stay and nothing else joins them", () => {
    expect(labels(slashQuery("/rev", 4) ?? "")).toEqual([
      "/review",
      "$review-agent",
      "/code-review",
      "/egm-review",
      "$pr-description",
    ]);
  });

  it("Given the input /mod, when the items are ranked, then the T3 action that starts with it leads a command that only mentions it", () => {
    const withModel = rankSlashItems(
      buildSlashItems({
        commands: [command({ name: "update-config", description: "Change the model" })],
        skills: [],
        actions: ["model"],
        messageIsOnlyTheCommand: true,
      }),
      "mod",
    );
    expect(withModel.map((item) => item.label)).toEqual(["/model", "/update-config"]);
  });

  it("Given the input /comp, when the items are ranked, then only /compact stays", () => {
    expect(labels("comp")).toEqual(["/compact"]);
  });

  it("Given a query with no match, when the items are ranked, then nothing stays", () => {
    expect(labels("zzz")).toEqual([]);
  });
});

describe("when the menu opens", () => {
  it.each([
    ["/", 1, ""],
    ["/rev", 4, "rev"],
    ["/rev and more", 4, "rev"],
    ["/rev and more", 13, null],
    ["hello /rev", 10, null],
    ["", 0, null],
  ])("Given the draft %j with the cursor at %i, then the query is %j", (draft, cursor, query) => {
    expect(slashQuery(draft, cursor)).toBe(query);
  });
});

describe("the message a picked item sends", () => {
  const pick = (id: string) => {
    const found = items.find((item) => item.id === id);
    if (found === undefined) throw new Error(id);
    return found;
  };

  it("Given a command and an argument, when it is turned into a message, then the argument follows the command", () => {
    expect(slashMessage(pick("command:compact"), "keep the ticket list")).toBe(
      "/compact keep the ticket list",
    );
  });

  it("Given a command with no argument, when it is turned into a message, then it is the command alone", () => {
    expect(slashMessage(pick("command:debug"), "  ")).toBe("/debug");
  });

  it("Given a skill and an argument, when it is turned into a message, then it is the $ mention, which the engine turns into the provider's own form", () => {
    expect(slashMessage(pick("skill:review-agent"), "the last commit")).toBe(
      "$review-agent the last commit",
    );
  });

  it("Given a T3 action, when it is turned into a message, then nothing is sent", () => {
    expect(slashMessage(pick("action:model"), "")).toBe("");
  });
});
