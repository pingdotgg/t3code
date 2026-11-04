// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { cases } from "./cases.ts";

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeCrypto>()),
  randomInt: vi.fn(),
}));

vi.mock("../../apps/server/src/textGeneration/ClaudeTextGeneration.ts", () => ({
  makeClaudeTextGeneration: () =>
    Effect.succeed({
      generateSessionRecap: () =>
        Effect.succeed({ summary: "The trace points to a retry timer.", nextAction: null }),
    }),
}));

it.each([false, true])("writes blind review artifacts (baseline: %s)", async (compare) => {
  vi.mocked(NodeCrypto.randomInt)
    .mockReset()
    .mockImplementationOnce(() => 0)
    .mockImplementationOnce(() => 1);
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-recap-report-"));
  const argv = process.argv;
  const fixture = cases.find((entry) => entry.id === "no-next-action")!;
  const previousOutputs = [
    { summary: "A retry timer was investigated.", nextAction: null },
    { summary: "The investigation identified a timer.", nextAction: null },
  ];
  const previous = {
    model: "haiku",
    rows: [1, 0].map((sample) => ({ ...fixture, sample, output: previousOutputs[sample] })),
  };
  try {
    const baselinePath = NodePath.join(directory, "baseline.json");
    await NodeFSP.writeFile(baselinePath, JSON.stringify(previous));
    process.argv = [
      "node",
      "run.ts",
      "--out",
      directory,
      "--case",
      fixture.id,
      "--samples",
      "2",
      ...(compare ? ["--baseline", baselinePath] : []),
    ];
    vi.resetModules();
    await import("./run.ts");
    const read = async (name: string) =>
      JSON.parse(await NodeFSP.readFile(NodePath.join(directory, `${name}.json`), "utf8"));
    const results = await read("results");
    const review = await read("review");
    const key = await read("answer-key");
    const summary = await read("summary");
    expect(review).toHaveLength(2);
    expect(key).toEqual([
      { id: fixture.id, sample: 0, candidate: "A" },
      { id: fixture.id, sample: 1, candidate: compare ? "B" : "A" },
    ]);
    for (const [index, row] of review.entries()) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "id",
          "sample",
          "source",
          "messages",
          "rubric",
          "A",
          ...(compare ? ["B"] : []),
          "grades",
          "preferred",
        ].sort(),
      );
      expect(row).toMatchObject({
        id: fixture.id,
        sample: index,
        messages: fixture.messages,
        rubric: fixture.rubric,
      });
      expect(row[key[index].candidate]).toEqual(results.rows[index].output);
      if (compare) {
        expect(row[key[index].candidate === "A" ? "B" : "A"]).toEqual(previousOutputs[index]);
      }
      expect(row.grades).toEqual(compare ? { A: "", B: "" } : { A: "" });
    }
    expect(JSON.stringify(review)).not.toMatch(/current|baseline|candidate|haiku/);
    expect(summary).toMatchObject({
      model: "haiku",
      cases: 1,
      samples: 2,
      baseline: compare,
      reports: { results: "results.json", review: "review.json", answerKey: "answer-key.json" },
      cost: { usd: null, status: "unavailable", reason: expect.any(String) },
      grading: expect.stringContaining("more than half"),
    });
  } finally {
    process.argv = argv;
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it.each(["model", "missing", "duplicate", "messages", "rubric"])(
  "rejects an incompatible baseline: %s",
  async (mismatch) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-recap-report-"));
    const argv = process.argv;
    const fixture = cases[0];
    const row = {
      ...fixture,
      sample: 0,
      output: { summary: "A marker was returned.", nextAction: null },
      ...(mismatch === "messages" ? { messages: "A different excerpt." } : {}),
      ...(mismatch === "rubric" ? { rubric: "A different rubric." } : {}),
    };
    try {
      const baselinePath = NodePath.join(directory, "baseline.json");
      await NodeFSP.writeFile(
        baselinePath,
        JSON.stringify({
          model: mismatch === "model" ? "another-model" : "haiku",
          rows: mismatch === "missing" ? [] : mismatch === "duplicate" ? [row, row] : [row],
        }),
      );
      process.argv = [
        "node",
        "run.ts",
        "--out",
        directory,
        "--case",
        fixture.id,
        "--samples",
        "1",
        "--baseline",
        baselinePath,
      ];
      vi.resetModules();
      await expect(import("./run.ts")).rejects.toThrow(
        mismatch === "model" ? "same model" : "matching excerpt and rubric",
      );
    } finally {
      process.argv = argv;
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
