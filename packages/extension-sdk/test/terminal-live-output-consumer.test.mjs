import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { createOutputModel } from "../examples/installable-terminal-live-output/client.mjs";
const base = { terminalId: "term-1", streamEpoch: "epoch" };
const snapshot = (extra = {}) => ({
  ...base,
  kind: "snapshot",
  status: "running",
  contents: "before",
  retainedByteLength: 6,
  truncated: false,
  clearGeneration: 0,
  contentsUnitStart: 0,
  boundarySequence: 10,
  ...extra,
});
const output = (sequence, data, extra = {}) => ({
  ...base,
  kind: "output",
  sequence,
  chunkIndex: 0,
  chunkCount: 1,
  data,
  ...extra,
});
function feed(model) {
  let sequence = 0;
  return (value) =>
    model.accept({
      type: {
        snapshot: "snapshot",
        output: "data",
        reset: "reset",
        exit: "data",
        closed: "closed",
      }[value.kind],
      streamId: "stream",
      sequence: ++sequence,
      value,
    });
}
NodeTest.test(
  "independent output consumer displays only complete ordered native chunks, then clear and exit",
  () => {
    const model = createOutputModel("term-1"),
      accept = feed(model);
    accept(snapshot());
    NodeAssert.equal(
      accept(output(11, "hello ", { chunkIndex: 0, chunkCount: 2 })).contents,
      "before",
    );
    NodeAssert.equal(
      accept(output(11, "😺雪", { chunkIndex: 1, chunkCount: 2 })).contents,
      "beforehello 😺雪",
    );
    NodeAssert.equal(
      accept({ ...base, kind: "reset", sequence: 12, reason: "history-cleared" }).contents,
      "",
    );
    NodeAssert.equal(
      accept(output(14, "\u001b[31mred\u001b[0m")).contents,
      "\u001b[31mred\u001b[0m",
    );
    accept({ ...base, kind: "exit", sequence: 15, exitCode: 0, exitSignal: null });
    NodeAssert.match(model.finish().status, /exited/);
    NodeAssert.throws(() => accept(output(16, "late")), /after terminal lifecycle/);
  },
);
NodeTest.test(
  "incomplete, reordered or foreign output never becomes a completed display update",
  () => {
    const cases = [
      output(10, "duplicate"),
      output(11, "missing-first", { chunkIndex: 1, chunkCount: 2 }),
      { ...output(11, "foreign"), streamEpoch: "other" },
      { ...output(11, "foreign"), terminalId: "other" },
      output(11, "large", { chunkCount: 65 }),
      output(11, "x".repeat(8193)),
    ];
    for (const value of cases) {
      const accept = feed(createOutputModel("term-1"));
      accept(snapshot());
      NodeAssert.throws(() => accept(value));
    }
    const model = createOutputModel("term-1"),
      accept = feed(model);
    accept(snapshot());
    accept(output(11, "part", { chunkCount: 2 }));
    NodeAssert.throws(() => accept(output(12, "new")), /discontinuous/);
    NodeAssert.throws(() => model.finish(), /without a complete/);
  },
);
NodeTest.test(
  "overflow and reincarnation are explicit unavailable states that clear old output",
  () => {
    for (const reason of ["overflow", "identity-changed", "terminal-closed", "terminal-error"]) {
      const model = createOutputModel("term-1"),
        accept = feed(model);
      accept(snapshot());
      accept(output(11, "uncommitted", { chunkCount: 2 }));
      const final = accept({ ...base, kind: "closed", reason });
      NodeAssert.equal(final.contents, "");
      NodeAssert.match(final.status, new RegExp(reason));
      NodeAssert.equal(model.finish(), final);
    }
  },
);
NodeTest.test("consumer has bounded pending data and a surrogate-safe displayed tail", () => {
  const model = createOutputModel("term-1"),
    accept = feed(model);
  accept(snapshot({ contents: "" }));
  for (let i = 0; i < 32; i++)
    accept(output(11, "x".repeat(8192), { chunkIndex: i, chunkCount: 33 }));
  NodeAssert.throws(
    () => accept(output(11, "x", { chunkIndex: 32, chunkCount: 33 })),
    /consumer bound/,
  );
  const next = feed(createOutputModel("term-1"));
  next(snapshot({ contents: "" }));
  next(output(11, "x".repeat(8192)));
  const value = next(output(12, "😺" + "y".repeat(8190), { chunkCount: 2 }));
  NodeAssert.equal(
    value.contents.length,
    8192,
    "incomplete group leaves the previous bounded tail",
  );
});
NodeTest.test(
  "display trimming never splits a surrogate pair and disconnected streams cannot claim continuity",
  () => {
    const model = createOutputModel("term-1"),
      accept = feed(model);
    accept(snapshot({ contents: "😺" + "y".repeat(8190) }));
    const display = accept(output(11, "z"));
    NodeAssert.equal(display.contents, "y".repeat(8190) + "z");
    NodeAssert.throws(() => model.finish(), /without a complete/);
    const ended = createOutputModel("term-1"),
      ready = feed(ended);
    ready(snapshot({ status: "exited" }));
    NodeAssert.match(ended.finish().status, /exited/);
  },
);
