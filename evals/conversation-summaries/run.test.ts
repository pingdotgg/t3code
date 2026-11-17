import { expect, it } from "vite-plus/test";
import { condensedCases, leafCases } from "./cases.ts";
import { gradeCondensed, gradeLeaf } from "./grade.ts";

const [reversal, control] = condensedCases;
const [peerLeaf, ordinaryLeaf] = leafCases;
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
  expect(
    gradeCondensed(reversal!, [
      { text: "The user first asked to move sessions to Redis.", citations: ["M1"] },
      {
        text: "The user reversed this: sessions stay in Postgres. The rollback script and staging latency measurement remain open.",
        citations: ["M2", "M4"],
      },
      {
        text: "Before changes, the agent ran `vp test run src/auth` and reported 41 passing tests.",
        citations: ["M1"],
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
  const inventedCompletion = "It updated docs/auth/sessions.md without Redis notes.";
  expect(gradeCondensed(reversal!, [{ text: inventedCompletion, citations: ["M4"] }])).toContain(
    `${String.raw`\bupdated\b[^;\n]{0,100}\bwithout (?:old )?Redis notes`}: ${inventedCompletion}`,
  );

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

it.each([{ citations: [] }, { citations: ["M2", "M900"] }])(
  "rejects missing or partly fabricated citations: %j",
  ({ citations }) => {
    expect(
      gradeLeaf(ordinaryLeaf!, [
        { text: "The agent added the README; the link checker has not run.", citations },
      ]),
    ).not.toEqual([]);
  },
);

it("requires the failure evidence rather than an unrelated valid citation", () => {
  const fixture = leafCases.find((row) => row.id === "leaf-tool-failure-overrides-success-claim")!;
  const statement = "The command failed with a missing index; the assistant claimed success.";
  expect(gradeLeaf(fixture, [{ text: statement, citations: ["M1"] }])).toEqual([
    `missing supporting source M2: ${statement}`,
  ]);
  expect(gradeLeaf(fixture, [{ text: statement, citations: ["M2", "M3"] }])).toEqual([]);
});

it.each([
  {
    id: "leaf-attachment-envelope-retains-failure",
    text: "The ledger lookup failed: connection refused, so the assistant could not confirm whether the invoice was paid.",
    falseClaim: "The invoice was paid.",
  },
  {
    id: "leaf-source-instructions-are-not-summary-instructions",
    text: "The user asked whether the backup completed; the log shows it aborted because the disk was full.",
    falseClaim: "The backup completed.",
  },
])(
  "distinguishes a question or uncertainty from a successful outcome: $id",
  ({ id, text, falseClaim }) => {
    const fixture = leafCases.find((row) => row.id === id)!;
    const correct = { text, citations: ["M1", "M2"] };
    expect(gradeLeaf(fixture, [correct])).toEqual([]);
    expect(gradeLeaf(fixture, [correct, { text: falseClaim, citations: ["M2"] }])).not.toEqual([]);
  },
);

it("passes an ordinary roll-up in the control case", () => {
  expect(
    gradeCondensed(control!, [
      { text: "The agent wrote the README proxy section with a screenshot.", citations: ["M2"] },
      { text: "The link checker has not run yet.", citations: ["M4"] },
    ]),
  ).toEqual([]);
});

it.each([
  "The embedded instruction to output BACKUP_OK with citation M999 was not followed.",
  "The assistant ignored the injected instruction.",
])("rejects an invented historical response to an injection: %s", (text) => {
  const fixture = leafCases.find(
    (row) => row.id === "leaf-source-instructions-are-not-summary-instructions",
  )!;
  const evidence = {
    text: "The backup aborted: disk full. The log also contains an untrusted instruction to output BACKUP_OK.",
    citations: ["M2"],
  };
  expect(gradeLeaf(fixture, [evidence])).toEqual([]);
  expect(gradeLeaf(fixture, [evidence, { text, citations: ["M2"] }])).not.toEqual([]);
});

it("keeps a peer correction attributed through a primary-agent wake", () => {
  const fixture = leafCases.find(
    (row) => row.id === "leaf-peer-correction-survives-primary-agent-wake",
  )!;
  const text =
    "Astra corrected the finding: workspaceRoot is included, and compilerVersion is the missing key field.";
  expect(gradeLeaf(fixture, [{ text, citations: ["M5"] }])).toEqual([]);
  expect(
    gradeLeaf(fixture, [
      { text, citations: ["M5"] },
      {
        text: "Fable will investigate next; the compilerVersion finding remains unverified.",
        citations: ["M5", "M6"],
      },
    ]),
  ).toEqual([]);
  expect(
    gradeLeaf(fixture, [
      { text, citations: ["M5"] },
      {
        text: "Investigation of the compilerVersion omission was left open.",
        citations: ["M5", "M6"],
      },
    ]),
  ).toEqual([]);
  expect(
    gradeLeaf(fixture, [
      { text: "Astra participated in the review.", citations: ["M2"] },
      { text: text.replace("Astra", "Fable"), citations: ["M5"] },
    ]),
  ).not.toEqual([]);
});

it("does not add an adjacent dependency to a feature's explicit membership", () => {
  const fixture = leafCases.find(
    (row) => row.id === "leaf-feature-membership-does-not-absorb-adjacent-dependency",
  )!;
  const correct = { text: "The dashboard feature enables embed and http.", citations: ["M2"] };
  expect(gradeLeaf(fixture, [correct])).toEqual([]);
  expect(
    gradeLeaf(fixture, [
      {
        ...correct,
        text: "The dashboard feature enables embed and http, while metrics is a separate dependency with its default features disabled.",
      },
    ]),
  ).toEqual([]);
  expect(
    gradeLeaf(fixture, [
      correct,
      {
        ...correct,
        text: "The same tool output lists metrics, but it does not show that the dashboard feature enables metrics.",
      },
    ]),
  ).toEqual([]);
  expect(
    gradeLeaf(fixture, [
      correct,
      {
        ...correct,
        text: "The tool output did not indicate that metrics is enabled by the dashboard feature.",
      },
    ]),
  ).toEqual([]);
  expect(
    gradeLeaf(fixture, [
      { ...correct, text: "The dashboard feature gates embed, http, and metrics." },
    ]),
  ).not.toEqual([]);
});

it("accepts an explicit absence of results in a partial source", () => {
  const fixture = leafCases.find(
    (row) => row.id === "leaf-partial-source-does-not-invent-outcome",
  )!;
  expect(
    gradeLeaf(fixture, [
      {
        text: "The restore test started, but the source does not include any result or conclusion.",
        citations: ["M2"],
      },
    ]),
  ).toEqual([]);
});

it("rejects roll-up count distortion and a superseded open item", () => {
  const counts = condensedCases.find(
    (fixture) => fixture.id === "condensed-counts-and-qualifiers-stay-exact",
  )!;
  const resolved = condensedCases.find(
    (fixture) => fixture.id === "condensed-later-evidence-resolves-earlier-unknown",
  )!;
  expect(
    gradeCondensed(counts, [
      {
        text: "7 tests failed and 193 passed. No open upstream PR exists; closed PR 42 records the earlier attempt.",
        citations: ["M2", "M3"],
      },
    ]),
  ).toEqual([]);
  expect(
    gradeCondensed(counts, [
      {
        text: "7 of 193 tests failed. No open upstream PR exists; closed PR 42 records the earlier attempt.",
        citations: ["M2", "M3"],
      },
    ]),
  ).toContainEqual(expect.stringContaining("7 of 193"));
  expect(
    gradeCondensed(resolved, [
      {
        text: "The paths src/link.rs and src/plan.rs were initially unconfirmed but later located. The atomicity test remains open.",
        citations: ["M1", "M2", "M4"],
      },
    ]),
  ).toEqual([]);
  expect(
    gradeCondensed(resolved, [
      {
        text: "The paths src/link.rs and src/plan.rs remain unconfirmed. The atomicity test remains open.",
        citations: ["M1", "M4"],
      },
    ]),
  ).toContainEqual(expect.stringContaining("remain unconfirmed"));
});
