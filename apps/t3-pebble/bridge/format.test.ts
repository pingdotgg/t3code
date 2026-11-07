import { expect, test } from "bun:test";
import format from "../src/pkjs/format.js";
import summary from "../src/pkjs/summary.js";

test("formats markdown and colors code while retaining newlines and long words", () => {
  const text = format("# Heading\n**bold** and `git status`\n```sh\necho 'hello' # comment\n```", "assistant_message");
  expect(text).toContain("\x02Heading\x01");
  expect(text).toContain("\x02bold\x01");
  expect(text).toContain("\x04git\x03");
  expect(text).toContain("\x05'hello'\x03");
  expect(text).toContain("\x07# comment\x03");
  expect(text).toContain("\n");
  expect(format("$ git status", "command_execution")).toContain("\x04git\x03");
  const progress = format("$ download\nN/A%[    ] 0 B/s\rN/A%[  ] 5 B/s\rSaved file\n", "command_execution");
  expect(progress.replace(/[\x01-\x07]/g, "")).toContain("Saved file");
  expect(progress).not.toContain("N/A%");
  expect(format("\u001b[31mred\u001b[0m", "command_execution")).not.toContain("\u001b");
});

test("summarizes commands and reasoning like the desktop client", () => {
  expect(summary({ type: "command_execution", title: "  bun test  " })).toBe("bun test");
  expect(summary({ type: "command_execution", title: "" })).toBe("Ran command");
  expect(summary({ type: "reasoning", title: "Checking tests" })).toBe("Checking tests");
  expect(summary({ type: "reasoning", title: "" })).toBe("Thinking");
  expect(summary({ type: "assistant_message", title: "Hi" })).toBe("");
});

const completed = (itemId: string, type: string, extra: Record<string, unknown> = {}) => ({
  type,
  status: "completed",
  title: type,
  itemId,
  ...extra,
});

test("groups completed commands and reads with reasoning left out of the counts", () => {
  const entries = summary.group(
    [
      completed("u1", "user_message", { text: "run the tests" }),
      completed("c1", "command_execution", { title: "$ bun test" }),
      completed("r1", "reasoning", { title: "Checking the suite" }),
      completed("c2", "command_execution", { title: "$ bun build" }),
      completed("c3", "command_execution", { title: "$ bun lint" }),
      completed("d1", "dynamic_tool", { title: "Read a.ts", text: '{"toolName":"read"}' }),
      completed("r2", "reasoning", { title: "Reviewing output" }),
      completed("d2", "dynamic_tool", { title: "Read b.ts", text: '{"toolName":"read"}' }),
      completed("d3", "dynamic_tool", { title: "Read c.ts", text: '{"toolName":"read"}' }),
      completed("a1", "assistant_message", { text: "All green" }),
    ],
    format,
  );
  expect(entries.map((entry: { type: string }) => entry.type)).toEqual([
    "user_message",
    "work_group",
    "assistant_message",
  ]);
  expect(entries[1].summary).toBe("Ran 3 commands and read 3 files");
  expect(entries[1].item).toBe("c1");
  expect(entries[1].status).toBe("completed");
  const text = entries[1].text.replace(/[\x01-\x07]/g, "");
  expect(text).toContain("bun test");
  expect(text).toContain("bun lint");
  expect(text).toContain("\n\n");
});

test("lowercases later labels in three-part summaries", () => {
  const entries = summary.group(
    [
      completed("f1", "file_change", { changedFiles: ["a.ts"] }),
      completed("c1", "command_execution", { title: "$ one" }),
      completed("d1", "dynamic_tool", { title: "other tool" }),
    ],
    format,
  );
  expect(entries[0].summary).toBe("Changed 1 file, ran 1 command, and performed 1 other action");
});

test("summarizes reasoning-only groups as thought", () => {
  expect(summary.group([completed("r1", "reasoning", { title: "Planning" })], format)[0].summary).toBe(
    "Thought",
  );
  const entries = summary.group(
    [completed("r1", "reasoning", { title: "Planning" }), completed("r2", "reasoning", { title: "Again" })],
    format,
  );
  expect(entries[0].summary).toBe("Thought (×2)");
  expect(entries[0].text).toContain("Planning");
  expect(entries[0].text).toContain("Again");
});

test("messages and active work break groups", () => {
  const entries = summary.group(
    [
      completed("c1", "command_execution", { title: "$ one" }),
      completed("a1", "assistant_message", { text: "hold on" }),
      completed("c2", "command_execution", { title: "$ two" }),
      { type: "command_execution", status: "running", title: "$ three", itemId: "c3" },
      completed("c4", "command_execution", { title: "$ four" }),
    ],
    format,
  );
  expect(entries.map((entry: { type: string }) => entry.type)).toEqual([
    "work_group",
    "assistant_message",
    "work_group",
    "command_execution",
    "work_group",
  ]);
  expect(entries[0].summary).toBe("Ran 1 command");
  expect(entries[2].summary).toBe("Ran 1 command");
  expect(entries[3].status).toBe("running");
  expect(entries[3].title).toBe("$ three");
});

test("namespaces group ids by thread identity and source position when members lack itemIds", () => {
  const namespace = "t3code/claude/mac-mini";
  const members = [
    { type: "command_execution", status: "completed", title: "$ one", position: 7 },
    { type: "command_execution", status: "completed", title: "$ two", position: 8 },
  ];
  expect(summary.group(members, format, namespace)[0].item).toBe(`${namespace}#7`);
  expect(
    summary.group([{ ...members[0], itemId: "real-id" }], format, namespace)[0].item,
  ).toBe("real-id");
});

test("retains up to 900 formatted body characters", () => {
  const strip = (text: string) => text.replace(/[\x01-\x07]/g, "");
  expect(strip(format("z".repeat(950), "assistant_message"))).toHaveLength(900);
  expect(strip(format("z".repeat(950), "command_execution"))).toHaveLength(900);
});
