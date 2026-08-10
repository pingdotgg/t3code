// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { discoverProviderConversations, stableHash, type ProviderImportConfig } from "./readers.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => NodeFSP.rm(directory, { recursive: true })),
  );
});

async function fixtureRoot(): Promise<{ readonly root: string; readonly home: string }> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-thread-import-"));
  const home = NodePath.join(root, "provider-home");
  await NodeFSP.mkdir(home, { recursive: true });
  temporaryDirectories.push(root);
  return { root, home };
}

async function writeJsonl(path: string, records: ReadonlyArray<unknown>): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function config(
  provider: ProviderImportConfig["provider"],
  home: string,
  projectRoot: string,
): ProviderImportConfig {
  return {
    provider,
    providerInstanceId: ProviderInstanceId.make(`${provider}-test`),
    displayName: provider,
    config: { homePath: home },
    environment: { CURSOR_HOME: home, GROK_HOME: home },
    defaultModel: undefined,
    projectRoot,
  };
}

describe("external thread import readers", () => {
  it("reads Claude Code JSONL and preserves the resume UUID", async () => {
    const { root, home } = await fixtureRoot();
    await writeJsonl(NodePath.join(home, "projects", "workspace", "claude.jsonl"), [
      {
        type: "user",
        sessionId: "11111111-1111-4111-8111-111111111111",
        cwd: root,
        message: { role: "user", content: [{ type: "text", text: "Fix the import" }] },
      },
      {
        type: "assistant",
        sessionId: "11111111-1111-4111-8111-111111111111",
        cwd: root,
        message: { role: "assistant", content: [{ type: "text", text: "I will inspect it." }] },
      },
    ]);

    const [conversation] = await discoverProviderConversations(config("claudeAgent", home, root));
    expect(conversation?.messages.map((message) => message.text)).toEqual([
      "Fix the import",
      "I will inspect it.",
    ]);
    expect(conversation?.resumeCursor).toEqual({
      resume: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("reads Codex rollout event records and matches the exact workspace", async () => {
    const { root, home } = await fixtureRoot();
    await writeJsonl(NodePath.join(home, "sessions", "rollout.jsonl"), [
      { type: "session_meta", payload: { id: "codex-session-1", cwd: root } },
      { type: "event_msg", payload: { type: "user_message", message: "Review this" } },
      {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ text: "Looks good." }] },
      },
    ]);

    const [conversation] = await discoverProviderConversations(config("codex", home, root));
    expect(conversation?.sourceCwd).toBe(root);
    expect(conversation?.messages.map((message) => message.text)).toEqual([
      "Review this",
      "Looks good.",
    ]);
    expect(conversation?.resumeCursor).toEqual({ threadId: "codex-session-1" });
  });

  it("reads Cursor ACP chunks and merges adjacent transcript chunks", async () => {
    const { root, home } = await fixtureRoot();
    await writeJsonl(NodePath.join(home, "chats", "cursor.jsonl"), [
      {
        sessionId: "cursor-session-1",
        cwd: root,
        sessionUpdate: "user_message_chunk",
        content: "Hel",
      },
      {
        sessionId: "cursor-session-1",
        cwd: root,
        sessionUpdate: "user_message_chunk",
        content: "lo",
      },
      {
        sessionId: "cursor-session-1",
        cwd: root,
        sessionUpdate: "agent_message_chunk",
        content: "Hi",
      },
    ]);

    const [conversation] = await discoverProviderConversations(config("cursor", home, root));
    expect(conversation?.messages.map((message) => message.text)).toEqual(["Hello", "Hi"]);
    expect(conversation?.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "cursor-session-1" });
  });

  it("uses Grok's JSON fallback when the read-only store has no SQLite file", async () => {
    const { root, home } = await fixtureRoot();
    await writeJsonl(NodePath.join(home, "sessions", "grok.json"), [
      { id: "grok-session-1", cwd: root, type: "user", message: "Build this" },
      { id: "grok-session-1", cwd: root, type: "assistant", message: "Done" },
    ]);

    const [conversation] = await discoverProviderConversations(config("grok", home, root));
    expect(conversation?.messages.map((message) => message.text)).toEqual(["Build this", "Done"]);
    expect(conversation?.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "grok-session-1" });
  });

  it("skips malformed and unknown records without exposing source paths", async () => {
    const { root, home } = await fixtureRoot();
    const badPath = NodePath.join(home, "projects", "bad.jsonl");
    await writeJsonl(badPath, [
      { type: "future_record_v99", cwd: root, payload: { opaque: true } },
      { type: "assistant", cwd: root, message: "readable" },
      { malformed: true },
    ]);
    await NodeFSP.appendFile(badPath, "not-json\n");
    await writeJsonl(NodePath.join(home, "projects", "wrong.jsonl"), [
      { type: "user", cwd: NodePath.join(root, "other"), message: "wrong workspace" },
    ]);

    const conversations = await discoverProviderConversations(config("claudeAgent", home, root));
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.messages.map((message) => message.text)).toEqual(["readable"]);
    expect(conversations[0]?.warnings).toEqual([
      "Skipped 1 malformed provider record(s).",
      "Skipped 1 provider record(s) from an unknown version.",
      "Claude session UUID was not found; imported as transcript-only.",
    ]);
    expect(stableHash("same-input")).toBe(stableHash("same-input"));
    expect(stableHash("same-input")).not.toBe(stableHash("different-input"));
  });
});
