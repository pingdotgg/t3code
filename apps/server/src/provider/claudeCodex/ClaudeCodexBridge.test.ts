// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  commitStagedClaudeCodexAuth,
  directoryHasCodexBridgeCredential,
  parseClaudeCodexModelsPayload,
} from "./ClaudeCodexBridge.ts";

const fs = NodeFS;
const path = NodePath;

describe("ClaudeCodexBridge", () => {
  it("accepts only well-formed, unique model catalog entries", () => {
    expect(
      parseClaudeCodexModelsPayload({
        data: [
          { id: "gpt-5.6-sol", owned_by: "openai" },
          { id: "gpt-5.6-sol" },
          { id: "bad id" },
          null,
        ],
      }),
    ).toEqual([{ id: "gpt-5.6-sol", ownedBy: "openai" }]);
  });

  it("recognizes bridge-owned Codex credential files", () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), ".tmp-claude-codex-auth-"));
    try {
      fs.writeFileSync(
        path.join(directory, "codex-user-pro.json"),
        JSON.stringify({ type: "codex", access_token: "redacted", refresh_token: "redacted" }),
      );
      expect(directoryHasCodexBridgeCredential(directory)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replaces a connected account only after staged credentials validate", () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-claude-codex-switch-"));
    const live = path.join(root, "auth");
    const staging = path.join(root, "auth-staging");
    try {
      fs.mkdirSync(live);
      fs.mkdirSync(staging);
      fs.writeFileSync(path.join(live, "codex-old.json"), JSON.stringify({ type: "codex" }));
      fs.writeFileSync(path.join(staging, "invalid.json"), "{}");
      expect(() => commitStagedClaudeCodexAuth(live, staging, "linux")).toThrow();
      expect(fs.existsSync(path.join(live, "codex-old.json"))).toBe(true);

      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging);
      fs.writeFileSync(path.join(staging, "codex-new.json"), JSON.stringify({ type: "codex" }));
      commitStagedClaudeCodexAuth(live, staging, "linux");
      expect(fs.existsSync(path.join(live, "codex-old.json"))).toBe(false);
      expect(fs.existsSync(path.join(live, "codex-new.json"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
