import { assert, it } from "@effect/vitest";

import { codexReplayRecordingOutputRecords } from "./codexReplayRecordingRecords.ts";

it("preserves monotonic request ids across native Codex forks", () => {
  const records = [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: { id: 1, method: "initialize" },
    },
    {
      type: "expect_outbound",
      label: "thread/fork",
      frame: { id: 4, method: "thread/fork" },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: { id: 5, method: "turn/start" },
    },
  ];

  const output = codexReplayRecordingOutputRecords(records);

  assert.deepEqual(output, records);
  assert.deepEqual(
    output.map((record) => record.label),
    ["initialize", "thread/fork", "turn/start"],
  );
  assert.deepEqual(
    output.map((record) => (record.frame as { readonly id: number }).id),
    [1, 4, 5],
  );
});
