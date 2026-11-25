import { expect, it } from "vite-plus/test";
import { readSubagentCommand } from "./protocol.ts";
import { readSessionCommand } from "./sessionCommands.ts";

it("uses queued text verbatim when removing or promoting an Oh My Pi follow-up", () => {
  expect(readSessionCommand("/omp:queue-remove followUp First line\nSecond line")).toEqual({
    type: "remove_queued_message",
    queue: "followUp",
    message: "First line\nSecond line",
  });
  expect(readSessionCommand("/omp:queue-promote First line\nSecond line")).toEqual({
    type: "promote_queued_message",
    message: "First line\nSecond line",
  });
});

it("sends typed native compaction, retry, speed, and cache settings", () => {
  expect(readSessionCommand("/omp:auto-compact off")).toEqual({
    type: "set_auto_compaction",
    enabled: false,
  });
  expect(readSessionCommand("/omp:auto-retry on")).toEqual({
    type: "set_auto_retry",
    enabled: true,
  });
  expect(readSessionCommand("/omp:fast on")).toEqual({ type: "set_fast_mode", enabled: true });
  expect(readSessionCommand("/omp:slow off")).toEqual({ type: "set_slow_mode", enabled: false });
  expect(readSessionCommand("/omp:cache-warming streaming")).toEqual({
    type: "set_cache_warming",
    mode: "streaming",
  });
  expect(readSessionCommand("/omp:auto-retry toggle")).toEqual({ type: "invalid_session_command" });
  expect(readSessionCommand("/omp:cache-warming auto")).toEqual({
    type: "invalid_session_command",
  });
});

it("replaces native todos with an explicit checklist and rejects malformed tasks", () => {
  expect(
    readSessionCommand("/omp:todos-set # Verify\n- [x] Goal\n- [~] Queue\n- [ ] Import"),
  ).toEqual({
    type: "set_todos",
    phases: [
      {
        name: "Verify",
        tasks: [
          { content: "Goal", status: "completed" },
          { content: "Queue", status: "in_progress" },
          { content: "Import", status: "pending" },
        ],
      },
    ],
  });
  expect(readSessionCommand("/omp:todos-set # Verify\n- Accidental prose")).toEqual({
    type: "invalid_session_command",
  });
  expect(readSessionCommand("/omp:todos-clear")).toEqual({ type: "set_todos", phases: [] });
});

it("addresses transcripts by native subagent ID and rejects paths and invalid cursors", () => {
  expect(readSubagentCommand("/omp:subagent-log ExampleAgent 161")).toEqual({
    type: "get_subagent_messages",
    subagentId: "ExampleAgent",
    fromByte: 161,
  });
  expect(readSubagentCommand("/omp:subagent-log /tmp/example.jsonl")).toEqual({
    type: "invalid_subagent_command",
  });
  expect(readSubagentCommand("/omp:subagent-log ExampleAgent 9007199254740993")).toEqual({
    type: "invalid_subagent_command",
  });
});
