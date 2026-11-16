import { expect, it } from "vite-plus/test";
import { condensedCases, leafCases } from "./cases.ts";
import { gradeCondensed, gradeLeaf } from "./grade.ts";

const [reversal, control] = condensedCases;
const [peerLeaf, ordinaryLeaf] = leafCases;

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

it("fails a leaf that records the peer proposal as the user's decision", () => {
  expect(
    gradeLeaf(peerLeaf!, [
      { text: "The user decided to use Postgres for sessions.", citations: ["M2"] },
      { text: "The agent wants to keep Redis.", citations: ["M3"] },
    ]),
  ).toEqual([
    "missing Astra",
    "Postgres|[Dd]rop Redis without Astra: The user decided to use Postgres for sessions.",
    "[Uu]ser (decided|chose|wants|wanted|asked) to (drop Redis|use Postgres|keep Redis): The user decided to use Postgres for sessions.",
  ]);
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

it("passes an ordinary roll-up in the control case", () => {
  expect(
    gradeCondensed(control!, [
      { text: "The agent wrote the README proxy section with a screenshot.", citations: ["M2"] },
      { text: "The link checker has not run yet.", citations: ["M4"] },
    ]),
  ).toEqual([]);
});
