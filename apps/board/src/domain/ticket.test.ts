import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { parseTickets } from "./ticket";

const issueOf = (text: string) => {
  const parsed = parseTickets(text);
  if (Result.isSuccess(parsed)) throw new Error("expected the tickets to be rejected");
  return parsed.failure;
};

describe("tickets.json", () => {
  it("Given a ticket with every field, when it is parsed, then each field is kept", () => {
    const ticket = {
      key: "T-1",
      title: "Add login",
      stage: "building",
      track: "auth",
      dependsOn: ["T-0"],
      flags: ["blocked"],
      branch: "feat/login",
      base: "main",
      worktreePath: "/p/wt",
      pr: 12,
      headSha: "abc1234",
      summary: "Adds the form",
      why: "Users need it",
      threads: [{ threadId: "th-1", role: "task", round: 1 }],
      verdicts: [{ role: "reviewer", p0: 0, p1: 1, p2: 0, p3: 2 }],
      fixRounds: 1,
    };
    const parsed = parseTickets(JSON.stringify([ticket]));
    expect(Result.isSuccess(parsed) ? parsed.success : null).toEqual([ticket]);
  });

  it("Given a ticket with only key, title, and stage, when it is parsed, then it is accepted", () => {
    const parsed = parseTickets('[{"key":"T-1","title":"a","stage":"planned"}]');
    expect(Result.isSuccess(parsed)).toBe(true);
  });

  it("Given null for a field the orchestrator does not know yet, when it is parsed, then it is accepted", () => {
    const parsed = parseTickets(
      '[{"key":"T-1","title":"a","stage":"planned","branch":null,"pr":null,"threads":null}]',
    );
    expect(Result.isSuccess(parsed)).toBe(true);
  });

  it("Given the stage done, when it is parsed, then it is rejected and names stage", () => {
    const issue = issueOf('[{"key":"T-1","title":"a","stage":"done"}]');
    expect(issue.fields).toEqual(["stage"]);
    expect(issue.message).toContain("tickets.json is invalid: ");
    expect(issue.message).toContain("0.stage");
  });

  it("Given a missing title and a bad fix round count, when it is parsed, then both fields are named", () => {
    const issue = issueOf('[{"key":"T-1","stage":"planned","fixRounds":-1}]');
    expect(issue.fields).toEqual(["title", "fixRounds"]);
  });

  it("Given two tickets with one key, when it is parsed, then it is rejected and names key", () => {
    const issue = issueOf(
      '[{"key":"T-1","title":"a","stage":"planned"},{"key":"T-1","title":"b","stage":"merged"}]',
    );
    expect(issue).toEqual({
      fields: ["key"],
      message: "tickets.json is invalid: key T-1 is used by two tickets",
    });
  });

  it("Given text that is not a list, when it is parsed, then it is rejected as a file problem", () => {
    expect(issueOf("not json").fields).toEqual([]);
    expect(issueOf('{"key":"T-1"}').fields).toEqual([]);
  });
});
