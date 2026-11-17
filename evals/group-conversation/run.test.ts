import { describe, expect, it } from "vite-plus/test";
import { cases, type BehaviorCase } from "./cases.ts";
import {
  BehaviorVerdict,
  ComparisonVerdict,
  decide,
  gradeBehavior,
  parseVerdict,
  validateComparison,
  type Assessment,
  type ComparisonTrial,
} from "./grade.ts";
import { behaviorMessages, peerId } from "./prompts.ts";
import { simulateDiscussion } from "./simulate.ts";

const fixture = (id: string) =>
  cases.find((entry): entry is BehaviorCase => entry.id === id && entry.kind === "behavior")!;
const assessment = (engagement = 1): Assessment => ({
  ideas: 3,
  engagement,
  disagreement: 3,
  redundancy: 2,
  overlap: "noise",
  quotes: ["a reply"],
  reason: "Supported by the reply.",
});

describe("group behavior grading", () => {
  it("requires literal PASS only in the no-addition case and rejects PASS over an objection", () => {
    const result = { text: "PASS", calls: [], files: {} };
    expect(gradeBehavior(fixture("nothing-to-add"), result, { checks: [] }).pass).toBe(true);
    expect(
      gradeBehavior(
        fixture("nothing-to-add"),
        { ...result, text: "PASS, I agree." },
        { checks: [] },
      ).pass,
    ).toBe(false);
    expect(gradeBehavior(fixture("real-objection"), result, { checks: [] }).pass).toBe(false);
  });

  it.each([
    ["handoff-handle", "Can approval IDs survive a restart?\n@rowan", true],
    ["handoff-handle", "@rowan should check approval IDs.", false],
    ["handoff-handle", "Question.\n@rowan @kai", false],
    ["prose-mention", "The approval design came from @rowan.", true],
    ["prose-mention", "Thanks.\n@rowan", false],
    ["return-to-user", "Server-owned approvals.\n@user", true],
    ["return-to-user", "Server-owned approvals.\n@rowan", false],
  ])("uses actual final-line grammar for %s", (id, text, pass) => {
    expect(
      gradeBehavior(
        fixture(id),
        { text, calls: [], files: {} },
        {
          checks: [
            { criterion: 0, pass: true, quote: text, reason: "Contains the requested content." },
          ],
        },
      ).pass,
    ).toBe(pass);
  });

  it("requires actual edits and a substantive final reply rather than commentary", () => {
    const entry = fixture("public-reply-after-edit");
    const text = "Updated notes.txt so approvals survive server restarts.";
    const verdict = {
      checks: [
        { criterion: 0, pass: true, quote: text, reason: "The final reply describes the change." },
      ],
    };
    expect(
      gradeBehavior(
        entry,
        { text, calls: [], files: { "notes.txt": entry.edit!.content } },
        verdict,
      ).pass,
    ).toBe(true);
    expect(gradeBehavior(entry, { text, calls: [], files: {} }, verdict).pass).toBe(false);
    expect(
      gradeBehavior(
        entry,
        { text: "Done", calls: [], files: { "notes.txt": entry.edit!.content } },
        verdict,
      ).pass,
    ).toBe(false);
    expect(
      gradeBehavior(
        entry,
        {
          text,
          calls: [{ name: "write_file", input: {}, error: "Failed" }],
          files: { "notes.txt": entry.edit!.content },
        },
        verdict,
      ).pass,
    ).toBe(false);
    expect(
      gradeBehavior(
        fixture("side-chat-stays-separate"),
        { text, calls: [{ name: "write_file", input: {} }], files: {} },
        verdict,
      ).pass,
    ).toBe(false);
  });

  it("requires a delegate and all semantic criteria with evidence from the final answer or brief", () => {
    const entry = fixture("primary-carries-context");
    const text = "Kai's design is ready for implementation.";
    const input = {
      task: "Use a request ID and atomic single resolution. Reconnect returns the stored result.",
    };
    const result = { text, calls: [{ name: "delegate_task", input }], files: {} };
    const checks = [
      { criterion: 0, pass: true, quote: "Kai's design", reason: "Credits Kai." },
      {
        criterion: 1,
        pass: true,
        quote: "atomic single resolution",
        reason: "Includes the implementation decision.",
      },
    ];
    expect(gradeBehavior(entry, result, { checks }).pass).toBe(true);
    expect(gradeBehavior(entry, { ...result, calls: [] }, { checks }).pass).toBe(false);
    expect(gradeBehavior(entry, result, { checks: checks.slice(0, 1) }).pass).toBe(false);
    expect(gradeBehavior(entry, result, { checks: [checks[0]!, checks[0]!] }).pass).toBe(false);
    expect(
      gradeBehavior(entry, result, {
        checks: [{ ...checks[0]!, quote: "invented attribution" }, checks[1]!],
      }).pass,
    ).toBe(false);
    expect(
      gradeBehavior(entry, result, { checks: [checks[0]!, { ...checks[1]!, pass: false }] }).pass,
    ).toBe(false);
  });

  it("rejects malformed scores, invented evidence, and incomplete verdicts", () => {
    const verdict = { A: assessment(), B: assessment(3) };
    expect(validateComparison(verdict, "a reply", "a reply")).toEqual(verdict);
    expect(() => validateComparison(verdict, "something else", "a reply")).toThrow();
    expect(() =>
      validateComparison({ ...verdict, A: { ...verdict.A, quotes: [] } }, "a reply", "a reply"),
    ).toThrow();
    expect(() =>
      parseVerdict(
        ComparisonVerdict,
        JSON.stringify({ ...verdict, A: { ...verdict.A, ideas: 5 } }),
      ),
    ).toThrow();
    expect(() =>
      parseVerdict(ComparisonVerdict, JSON.stringify({ A: assessment(1.5), B: assessment() })),
    ).toThrow();
    expect(() =>
      parseVerdict(BehaviorVerdict, '{"checks":[{"criterion":0,"pass":"yes"}]}'),
    ).toThrow();
  });
});

describe("parallel decision rule", () => {
  const ids = ["sync", "approvals", "order"];
  const pairs = ["one,two", "three,four"];
  const trials = (): ComparisonTrial[] =>
    pairs.flatMap((pairing) =>
      ids.flatMap((id) =>
        [0, 1, 2].map((sample) => ({
          case: id,
          pairing,
          sample,
          parallel: assessment(1),
          serial: assessment(3),
        })),
      ),
    );

  it("switches only with consistent engagement, noisy overlap, and preserved ideas in both pairings", () => {
    expect(decide(trials(), ids, pairs, 0)).toMatchObject({
      decision: "serial",
      evidence: "measured",
    });
    expect(
      decide(
        trials().map((row) => ({ ...row, parallel: { ...row.parallel, overlap: "coverage" } })),
        ids,
        pairs,
        0,
      ).decision,
    ).toBe("parallel");
    expect(
      decide(
        trials().map((row) => ({ ...row, serial: { ...row.serial, ideas: 1 } })),
        ids,
        pairs,
        0,
      ).decision,
    ).toBe("parallel");
    expect(
      decide(
        trials().map((row) => ({ ...row, serial: { ...row.serial, disagreement: 1 } })),
        ids,
        pairs,
        0,
      ).decision,
    ).toBe("parallel");
    expect(
      decide(
        trials().map((row) => (row.pairing === pairs[0] ? row : { ...row, serial: assessment(1) })),
        ids,
        pairs,
        0,
      ).decision,
    ).toBe("parallel");
  });

  it("keeps parallel when trial spread meets or exceeds the gap or evidence is incomplete", () => {
    const spread = trials().map((row) => ({
      ...row,
      serial: assessment(row.sample === 0 ? 1 : 4),
    }));
    expect(decide(spread, ids, pairs, 0)).toMatchObject({
      decision: "parallel",
      evidence: "measured",
    });
    expect(
      decide(
        trials().filter((row) => row.sample !== 2),
        ids,
        pairs,
        0,
      ),
    ).toMatchObject({ decision: "parallel", evidence: "inconclusive" });
    expect(decide(trials(), ids, pairs, 1).evidence).toBe("inconclusive");
    expect(decide(trials(), ids, [pairs[0]!], 0).evidence).toBe("inconclusive");
    expect(decide([], ids, pairs, 0)).toMatchObject({
      decision: "parallel",
      evidence: "inconclusive",
    });
    expect(decide([...trials(), trials()[0]!], ids, pairs, 0).evidence).toBe("inconclusive");
  });
});

describe("production prompt and policy simulation", () => {
  it("starts with the lead, so the seat's first turn already reads the lead's reply", async () => {
    for (const parallel of [true, false]) {
      const result = await simulateDiscussion(
        "Design approvals.",
        parallel,
        async (member, messages) => ({
          role: "assistant",
          text: `${member === "primary" ? "Rowan" : "Kai"} reply ${messages.filter((message) => message.role === "assistant").length + 1}.`,
        }),
      );
      expect(result.entries).toHaveLength(5);
      expect(result.trace.map((wave) => wave.start)).toEqual([
        ["primary"],
        [peerId],
        ["primary"],
        [peerId],
      ]);
      const history = result.histories.find(([member]) => member === peerId)![1];
      expect(history[0]!.text).toContain("Rowan reply 1.");
      expect(history[2]!.text).toContain("Rowan reply 2.");
      expect(result.close).toBe("budget");
    }
  });

  it("tries an unanswered PASS once per member and honors an address to the user", async () => {
    for (const text of ["PASS", "The decision is settled.\n@user"]) {
      for (const parallel of [true, false]) {
        const result = await simulateDiscussion("Design approvals.", parallel, async () => ({
          role: "assistant",
          text,
        }));
        expect(result.entries).toHaveLength(text === "PASS" ? 3 : 2);
        expect(result.close).toBe("settled");
      }
    }
  });

  it("renders digest framing, edit identity, and public attribution through production renderers", () => {
    const edit = behaviorMessages(fixture("public-reply-after-edit"))[0]!.text;
    expect(edit).not.toContain("do not continue or redo the main thread's task");
    expect(edit).not.toContain("t3_thread_read");
    expect(edit).toContain("You are Kai, known here as @kai");
    expect(edit).toContain("you may read and edit it");
    expect(behaviorMessages(fixture("side-chat-stays-separate"))[0]!.text).toContain(
      "do not continue or redo the main thread's task",
    );
    const primary = behaviorMessages(fixture("primary-carries-context"))[0]!.text;
    expect(primary).toContain("speaker=Kai");
    expect(primary).toContain("A transaction resolves it once");
    const own = behaviorMessages(fixture("own-words"));
    expect(own.find((message) => message.role === "assistant")!.text).toContain(
      "field-level last-write-wins",
    );
    expect(own.at(-1)!.text).toContain("[Rowan]");
  });
});
