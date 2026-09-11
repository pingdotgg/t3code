// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { readClaudeAgentHistory } from "./claudeAgentHistory.ts";

const sessionId = "0945fcd9-8a8d-450a-b8cf-4ebd0ef17468";
let configDir: string;
beforeEach(async () => {
  configDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-agent-history-"));
});
afterEach(async () => {
  await NodeFSP.rm(configDir, { recursive: true, force: true });
});

/** Write a linked SDK transcript so reader tests exercise real chain reconstruction. */
async function save(agentId: string, contents: ReadonlyArray<unknown>, nested = false) {
  const directory = NodePath.join(
    configDir,
    "projects",
    "-workspace",
    sessionId,
    "subagents",
    ...(nested ? ["workflow", "review"] : []),
  );
  await NodeFSP.mkdir(directory, { recursive: true });
  let parentUuid: string | null = null;
  const lines = contents.map((content, index) => {
    const uuid = NodeCrypto.randomUUID();
    const type =
      index === 0 ||
      (Array.isArray(content) && content.some((block) => block.type === "tool_result"))
        ? "user"
        : "assistant";
    const row = {
      type,
      uuid,
      parentUuid,
      isSidechain: true,
      sessionId,
      agentId,
      timestamp: DateTime.formatIso(DateTime.makeUnsafe(index * 1000)),
      message: { role: type, content },
    };
    parentUuid = uuid;
    return JSON.stringify(row);
  });
  const file = NodePath.join(directory, `agent-${agentId}.jsonl`);
  await NodeFSP.writeFile(file, lines.join("\n") + "\n");
  return file;
}

const read = (agentId = "child", offset = 0) =>
  readClaudeAgentHistory({ configDir, sessionId, agentId, offset });

describe("Claude saved agent history", () => {
  it("skips malformed messages without losing subsequent valid history", async () => {
    await save("child", [
      "prompt",
      null,
      [{ type: "text", text: 42 }],
      [{ type: "text", text: "Valid answer" }],
    ]);
    const result = await read();
    expect(result.entries.map((entry) => entry.detail)).toEqual(["prompt", "Valid answer"]);
  });
  it("identifies file edits without putting patch content in the title", async () => {
    await save("child", [
      "prompt",
      [
        {
          type: "tool_use",
          id: "edit",
          name: "Edit",
          input: { file_path: "src/X.jsx", old_string: "old", new_string: "new" },
        },
      ],
    ]);
    const result = await read();
    expect(result.entries[1]).toMatchObject({ kind: "file-edit", title: "Edit src/X.jsx" });
    expect(result.entries[1]?.detail).toContain("new_string");
  });
  it("reads nested transcripts, preserves calls and results, and bounds entry detail", async () => {
    await save(
      "child",
      [
        "Review the changes",
        [
          { type: "text", text: "Checking the file" },
          { type: "tool_use", id: "tool1", name: "Read", input: { file_path: "index.ts" } },
        ],
        [
          {
            type: "tool_result",
            tool_use_id: "tool1",
            content: [{ type: "text", text: "x".repeat(9000) }],
          },
        ],
      ],
      true,
    );
    const result = await read();
    expect(result.status).toBe("ready");
    expect(result.entries.map((entry) => entry.title)).toEqual([
      "Prompt",
      "Agent",
      "Read",
      "Tool result",
    ]);
    expect(result.entries[2]?.detail).toContain("index.ts");
    expect(result.entries[3]?.detail).toHaveLength(8000);
    expect(result.entries[3]?.truncated).toBe(true);
  });

  it("paginates by visible entries without losing or repeating blocks", async () => {
    await save("child", [
      "Prompt",
      Array.from({ length: 55 }, (_, index) => ({ type: "text", text: `entry ${index}` })),
    ]);
    const first = await read();
    const second = await read("child", first.nextOffset!);
    expect(first.entries).toHaveLength(50);
    expect(second.entries).toHaveLength(6);
    expect(second.nextOffset).toBeNull();
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(56);
    expect(second.entries.at(-1)?.detail).toBe("entry 54");
  });

  it("does not cross parent sessions, provider homes, or follow child symlinks", async () => {
    const file = await save("child", ["private"]);
    expect(
      (
        await readClaudeAgentHistory({
          configDir,
          sessionId: NodeCrypto.randomUUID(),
          agentId: "child",
          offset: 0,
        })
      ).status,
    ).toBe("unavailable");
    expect(
      (
        await readClaudeAgentHistory({
          configDir: NodePath.join(configDir, "other-home"),
          sessionId,
          agentId: "child",
          offset: 0,
        })
      ).status,
    ).toBe("unavailable");
    expect((await read("../../child")).status).toBe("unavailable");
    if (HostProcessPlatform.defaultValue() !== "win32") {
      await NodeFSP.symlink(file, NodePath.join(NodePath.dirname(file), "agent-alias.jsonl"));
      expect((await read("alias")).status).toBe("unavailable");
    }
  });

  it("tolerates a record still being written but reports corruption in completed records", async () => {
    const file = await save("child", ["Prompt", [{ type: "text", text: "Done" }]]);
    await NodeFSP.appendFile(file, '{"type":');
    expect((await read()).entries).toHaveLength(2);
    await NodeFSP.appendFile(file, "\n");
    await expect(read()).rejects.toThrow();
  });
});
