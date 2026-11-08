// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";

interface ReplayEntry {
  readonly type: string;
  readonly frame?: {
    readonly method?: string;
    readonly params?: {
      prompt?: unknown;
      readonly update?: { readonly sessionUpdate?: string; readonly content?: { text?: string } };
    };
  };
}

const scriptPath = (file: string) => NodeURL.fileURLToPath(new URL(file, import.meta.url));

/** The checked-in simple Grok fixture as acp-replay-agent.ts reads it, with a different reply. */
function changedReplyTranscript(): string {
  const [, ...entries] = NodeFS.readFileSync(
    scriptPath("../src/orchestration-v2/testkit/fixtures/simple/grok_transcript.ndjson"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ReplayEntry);
  // The recorder sends the raw runtime-instructions prompt, which the fixture normalizes away.
  for (const entry of entries) {
    if (entry.type === "expect_outbound" && entry.frame?.method === "session/prompt") {
      entry.frame.params!.prompt = "<any>";
    }
  }
  const lastChunk = entries.findLast(
    (entry) => entry.frame?.params?.update?.sessionUpdate === "agent_message_chunk",
  );
  lastChunk!.frame!.params!.update!.content!.text = " changed";
  return JSON.stringify({ scenario: "simple", entries });
}

describe("record-grok-acp-replay-fixture", () => {
  it("leaves the fixture unchanged when the live run fails its checks", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-grok-recorder-"));
    try {
      const transcriptPath = NodePath.join(dir, "transcript.json");
      const statusPath = NodePath.join(dir, "status.json");
      NodeFS.writeFileSync(transcriptPath, changedReplyTranscript());
      const grokPath = writeFakeCli({
        directory: dir,
        name: "grok",
        source: execScriptSource({ scriptPath: scriptPath("./acp-replay-agent.ts") }),
        env: {
          T3_ACP_REPLAY_TRANSCRIPT_PATH: transcriptPath,
          T3_ACP_REPLAY_STATUS_PATH: statusPath,
        },
      });
      const outPath = NodePath.join(dir, "grok_transcript.ndjson");
      NodeFS.writeFileSync(outPath, "placeholder\n");

      const recorder = NodeChildProcess.spawn(
        process.execPath,
        [
          scriptPath("./record-grok-acp-replay-fixture.ts"),
          "--scenario",
          "simple",
          "--out",
          outPath,
        ],
        {
          cwd: scriptPath(".."),
          env: { ...process.env, T3_GROK_BIN: grokPath, HOME: dir, TMPDIR: dir },
          stdio: "ignore",
        },
      );
      const exitCode = await new Promise<number | null>((resolve) =>
        recorder.once("exit", resolve),
      );

      expect(exitCode).not.toBe(0);
      expect(NodeFS.readFileSync(outPath, "utf8")).toBe("placeholder\n");
      expect(NodeFS.existsSync(NodePath.join(dir, "grok-replay-simple-failed.json"))).toBe(true);
      const replay = JSON.parse(NodeFS.readFileSync(statusPath, "utf8")) as {
        readonly cursor: number;
        readonly total: number;
        readonly failure?: unknown;
      };
      expect(replay.failure).toBeUndefined();
      expect(replay.cursor).toBe(replay.total);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
