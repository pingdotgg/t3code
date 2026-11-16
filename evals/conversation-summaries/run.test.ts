import { expect, it } from "vite-plus/test";
import { condensedCases, knowledgeCases, leafCases } from "./cases.ts";
import { gradeCondensed, gradeKnowledge, gradeLeaf } from "./grade.ts";

const [reversal, control] = condensedCases;
const [peerLeaf, ordinaryLeaf] = leafCases;
const [peerKnowledge, conventionKnowledge] = knowledgeCases;
/** The full leaf grade of one statement beside a sibling that credits Astra, which passes alone. */
const gradeBesideAstra = (text: string) =>
  gradeLeaf(peerLeaf!, [
    { text: "Astra proposed Postgres for sessions.", citations: ["M2"] },
    { text, citations: ["M2"] },
  ]);

it("passes a roll-up that keeps the reversal, the attribution and the open item", () => {
  expect(
    gradeCondensed(reversal!, [
      {
        text: "The user first wanted Redis for sessions, then reversed it: sessions stay in Postgres.",
        citations: ["M1", "M2"],
      },
      {
        text: "The agent said the migration tests pass, but no output was shown; a rollback script and the staging latency check are still open.",
        citations: ["M3", "M4"],
      },
    ]),
  ).toEqual([]);
});

it("fails a roll-up that drops the reversal, verifies a claim, or overruns its budget", () => {
  const failures = gradeCondensed(reversal!, [
    { text: "Sessions move to Redis.", citations: ["M1"] },
    { text: "The user asked to omit old Redis notes from the docs.", citations: ["M4"] },
    { text: "Verified that the migration tests pass.", citations: ["M3"] },
    { text: "x".repeat(1_200), citations: ["M9"] },
  ]);
  expect(failures.filter((failure) => failure.includes("omit old Redis"))).toEqual([]);
  expect(failures).toEqual(
    expect.arrayContaining([
      "missing Postgres",
      "missing [Rr]ollback",
      "missing [Ss]taging|p95|latency",
      expect.stringMatching(/without .*: Sessions move to Redis\.$/),
      expect.stringMatching(/^\[Tt\]ests\?\\b without/),
      expect.stringMatching(/^cites no given source/),
      expect.stringMatching(/characters, over 1200$/),
    ]),
  );
});

it("passes a leaf that names the peer and leaves the choice open", () => {
  expect(
    gradeLeaf(peerLeaf!, [
      {
        text: "Astra proposed dropping Redis and using Postgres for sessions.",
        citations: ["M2"],
      },
      {
        text: "The agent disagreed and wants to keep Redis. The user has not decided.",
        citations: ["M1", "M3"],
      },
    ]),
  ).toEqual([]);
});

it.each([
  "Astra proposed dropping Redis and using Postgres for sessions.",
  "The user has not decided.",
  "The user has not chosen between Redis and Postgres; the agent prefers Redis.",
  "The user has yet to decide between Redis and Postgres.",
  "The user hasn't decided whether to use Postgres.",
  "The user is still deciding between Redis and Postgres.",
  "The user never agreed to Postgres.",
  "The agent rejected the proposal to use Postgres.",
  "The user decided to wait before choosing Postgres or Redis.",
  "The agent suggested keeping Redis rather than Postgres.",
])("leaves an open choice open: %s", (text) => {
  expect(gradeBesideAstra(text)).toEqual([]);
});

it.each([
  "The user decided to use Postgres for sessions.",
  "Astra proposed Postgres and the user agreed to use Postgres.",
  "The user chose Postgres for sessions, following Astra.",
  "The user accepted Astra's proposal, so sessions move to Postgres.",
  "The user went with Postgres.",
  "The user approved Postgres.",
  "Sessions will move to Postgres, per the user.",
  "The agent proposed moving sessions to Postgres; Astra wants to keep Redis.",
  "The user is going with Postgres.",
  "The user wants Postgres.",
  "The user's choice: Postgres for sessions.",
  "Per the user, sessions move to Postgres.",
  "The user later agreed and sessions moved to Postgres.",
  "The assistant answered that sessions should move to Postgres.",
  "The assistant recommended Postgres for sessions.",
])("fails a statement that hands the proposal to the user or the agent: %s", (text) => {
  expect(gradeBesideAstra(text)).not.toEqual([]);
});

it("does not treat an open Postgres choice as the peer's proposal", () => {
  expect(
    gradeLeaf(peerLeaf!, [
      {
        text: "The user has not chosen between Redis and Postgres; the agent prefers Redis.",
        citations: ["M1", "M3"],
      },
    ]),
  ).toEqual(["missing Astra"]);
});

it("passes an ordinary leaf with no peer", () => {
  expect(
    gradeLeaf(ordinaryLeaf!, [
      {
        text: "The user asked for a README section on the proxy, and the agent added it.",
        citations: ["M1", "M2"],
      },
      { text: "The link checker has not run yet.", citations: ["M2"] },
    ]),
  ).toEqual([]);
});

it("fails a fact candidate that saves the peer's proposal as the user's decision", () => {
  const content = "Sessions are stored in Postgres instead of Redis.";
  expect(
    gradeKnowledge(peerKnowledge!, [{ kind: "decision", content, citations: ["M2"] }]),
  ).toEqual([`decision: ${content}`]);
  expect(
    gradeKnowledge(peerKnowledge!, [
      { kind: "convention", content: "The user chose Postgres for sessions.", citations: ["M2"] },
    ]),
  ).not.toEqual([]);
  expect(
    gradeKnowledge(peerKnowledge!, [
      { kind: "convention", content: "Session storage is undecided.", citations: ["M1"] },
    ]),
  ).toEqual([]);
});

it("requires the control's plain user convention", () => {
  expect(gradeKnowledge(conventionKnowledge!, [])).toEqual(["missing snake_case"]);
  expect(
    gradeKnowledge(conventionKnowledge!, [
      { kind: "convention", content: "API responses use snake_case keys.", citations: ["M1"] },
    ]),
  ).toEqual([]);
});

it("passes an ordinary roll-up in the control case", () => {
  expect(
    gradeCondensed(control!, [
      { text: "The agent wrote the README proxy section with a screenshot.", citations: ["M2"] },
      { text: "The link checker has not run yet.", citations: ["M4"] },
    ]),
  ).toEqual([]);
});
