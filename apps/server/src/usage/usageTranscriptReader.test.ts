// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { listTranscriptFiles } from "./usageTranscriptReader.ts";

describe("listTranscriptFiles", () => {
  it("excludes Grok subagent ledgers already included by their parent", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-grok-usage-"));
    const parent = NodePath.join(root, "workspace", "parent-session");
    const child = NodePath.join(root, "workspace", "child-session");

    try {
      await NodeFSP.mkdir(NodePath.join(parent, "subagents", "child-session"), {
        recursive: true,
      });
      await NodeFSP.mkdir(child, { recursive: true });
      await Promise.all([
        NodeFSP.writeFile(NodePath.join(parent, "updates.jsonl"), "parent\n"),
        NodeFSP.writeFile(NodePath.join(child, "updates.jsonl"), "child\n"),
        NodeFSP.writeFile(NodePath.join(parent, "subagents", "child-session", "meta.json"), "{}"),
      ]);

      const files = await listTranscriptFiles(root, 0, "grok");

      expect(files.map((file) => file.path)).toEqual([NodePath.join(parent, "updates.jsonl")]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
