import { describe, expect, it } from "@effect/vitest";

import * as Schema from "effect/Schema";

import { VibeSettings } from "../settings.ts";
import {
  DEFAULT_VIBE_MODEL,
  applyVibeHistoryPatch,
  VIBE_DEFAULT_BINARY,
  buildVibeEnvironment,
  buildVibeSpawnInput,
  resolveVibeModelId,
  vibeAgentForRuntimeMode,
  vibeWorktreeInputForCwd,
} from "./appServerSupport.ts";

const decodeSettings = Schema.decodeSync(VibeSettings);

describe("buildVibeSpawnInput", () => {
  it("defaults to the vibe-app-server binary in the given checkout cwd", () => {
    const spawn = buildVibeSpawnInput(undefined, "/repo/.t3/worktrees/thread-1", { PATH: "/bin" });
    expect(spawn.command).toBe(VIBE_DEFAULT_BINARY);
    expect(spawn.args).toEqual([]);
    expect(spawn.cwd).toBe("/repo/.t3/worktrees/thread-1");
    expect(spawn.env?.PATH).toBe("/bin");
  });

  it("honours a configured binary path", () => {
    const spawn = buildVibeSpawnInput(
      { ...decodeSettings({}), binaryPath: "/opt/vibe/bin/vibe-app-server" },
      "/repo",
      undefined,
    );
    expect(spawn.command).toBe("/opt/vibe/bin/vibe-app-server");
  });
});

describe("buildVibeEnvironment", () => {
  it("passes the environment through when the local model is off", () => {
    const env = buildVibeEnvironment(decodeSettings({}), { HOME: "/home/u" });
    expect(env).toEqual({ HOME: "/home/u" });
  });

  it("injects VIBE_PROVIDERS/VIBE_MODELS for a local OpenAI-compatible endpoint", () => {
    const env = buildVibeEnvironment(
      decodeSettings({
        localModelEnabled: true,
        localModelBaseUrl: "http://localhost:8000/v1",
        localModelId: "devstral",
      }),
      { HOME: "/home/u" },
    );
    const providers = JSON.parse(env?.VIBE_PROVIDERS ?? "[]") as Array<Record<string, unknown>>;
    const models = JSON.parse(env?.VIBE_MODELS ?? "[]") as Array<Record<string, unknown>>;
    expect(providers[0]?.api_base).toBe("http://localhost:8000/v1");
    expect(providers[0]?.api_style).toBe("openai");
    expect(models[0]?.name).toBe("devstral");
    expect(models[0]?.provider).toBe("local");
    expect(env?.HOME).toBe("/home/u");
  });
});

describe("vibeAgentForRuntimeMode", () => {
  it("maps T3 runtime modes onto Vibe agents", () => {
    expect(vibeAgentForRuntimeMode("approval-required")).toEqual({
      agent: "default",
      autoApprove: false,
    });
    expect(vibeAgentForRuntimeMode("auto-accept-edits")).toEqual({
      agent: "accept-edits",
      autoApprove: false,
    });
    expect(vibeAgentForRuntimeMode("auto")).toEqual({ agent: "accept-edits", autoApprove: false });
    expect(vibeAgentForRuntimeMode("full-access")).toEqual({
      agent: "accept-edits",
      autoApprove: true,
    });
    expect(vibeAgentForRuntimeMode("approval-required", "plan")).toEqual({
      agent: "plan",
      autoApprove: false,
    });
  });
});

describe("resolveVibeModelId", () => {
  it("falls back to the default model slug", () => {
    expect(resolveVibeModelId(undefined)).toBe(DEFAULT_VIBE_MODEL);
    expect(resolveVibeModelId("  ")).toBe(DEFAULT_VIBE_MODEL);
    expect(resolveVibeModelId("devstral-small")).toBe("devstral-small");
  });
});

describe("vibeWorktreeInputForCwd", () => {
  it("adopts the thread's existing checkout as the session worktree", () => {
    expect(vibeWorktreeInputForCwd("/repo/.t3/worktrees/thread-1")).toEqual({
      kind: "existing",
      cwd: "/repo/.t3/worktrees/thread-1",
    });
  });
});

describe("applyVibeHistoryPatch", () => {
  it("concatenates streamed `append` chunks instead of replacing the text", () => {
    let entry: Record<string, unknown> = { content: [{ type: "text", text: "" }] };
    for (const chunk of ["Let me ", "check the ", "DB for the UUID."]) {
      entry = applyVibeHistoryPatch(entry, [
        { op: "append", path: "/content/0/text", value: chunk },
        { op: "replace", path: "/updatedAt", value: 1 },
      ]);
    }
    expect(entry).toEqual({
      content: [{ type: "text", text: "Let me check the DB for the UUID." }],
      updatedAt: 1,
    });
  });

  it("inserts into arrays for `add`, including the `-` end marker", () => {
    const entry = applyVibeHistoryPatch({ content: [{ type: "text", text: "a" }] }, [
      { op: "add", path: "/content/-", value: { type: "text", text: "c" } },
      { op: "add", path: "/content/1", value: { type: "text", text: "b" } },
    ]);
    expect(entry["content"]).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "text", text: "c" },
    ]);
  });
});
