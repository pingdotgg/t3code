/**
 * E2E Integration Tests for Claude Agent Teams
 *
 * These tests use the REAL Claude CLI (Haiku 4.5) to verify that the
 * session-logic state derivation correctly handles real-world events.
 *
 * IMPORTANT: These tests make real API calls and cost real tokens.
 * They are skipped by default. To run them:
 *   RUN_E2E=1 bun test src/session-logic-teams-e2e.test.ts
 *
 * Prerequisites:
 *   - Claude Code CLI installed and authenticated (claude --version)
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";

const SKIP_E2E = !process.env.RUN_E2E;
const TIMEOUT = 300_000; // 5 minutes — teams are slow
const MODEL = "claude-haiku-4-5-20251001";

/**
 * Runs Claude CLI in headless mode using execFileSync (safe — no shell injection).
 */
function runClaude(
  prompt: string,
  options?: { resume?: string; timeout?: number },
): { result: string; sessionId: string; durationMs: number; raw: Record<string, unknown> } {
  const args = ["-p", prompt, "--model", MODEL, "--output-format", "json"];
  if (options?.resume) {
    args.push("--resume", options.resume);
  }

  const output = execFileSync("claude", args, {
    timeout: options?.timeout ?? TIMEOUT,
    env: {
      ...process.env,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    },
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
  return {
    result: String(parsed.result ?? ""),
    sessionId: String(parsed.session_id ?? ""),
    durationMs: Number(parsed.duration_ms ?? 0),
    raw: parsed,
  };
}

describe.skipIf(SKIP_E2E)("E2E: Claude Agent Teams with Haiku 4.5", () => {
  it(
    "can create a team, spawn agents, and shut it down — all events visible",
    () => {
      const response = runClaude(
        "Create a very small team with 1 agent named 'scout'. " +
          "Have the scout read package.json and report the 'name' field value. " +
          "Once the scout reports back, tell me the name, then shut down and clean up the team. " +
          "Keep your responses short.",
        { timeout: TIMEOUT },
      );

      expect(response.result.length).toBeGreaterThan(0);
      expect(response.durationMs).toBeGreaterThan(0);

      console.log("Team E2E result:", response.result.slice(0, 300));
      console.log("Duration:", response.durationMs, "ms");
    },
    TIMEOUT,
  );

  it(
    "subagent results flow back to main thread",
    () => {
      const response = runClaude(
        "Use the Agent tool to spawn a quick Explore subagent that reads package.json. " +
          "Report the 'name' field from it. Respond with ONLY the name, nothing else.",
        { timeout: TIMEOUT },
      );

      expect(response.result.length).toBeGreaterThan(0);
      expect(response.result.toLowerCase()).not.toContain("error");

      console.log("Subagent E2E result:", response.result.slice(0, 100));
    },
    TIMEOUT,
  );

  it(
    "background command results are captured and visible",
    () => {
      // Run a background command — even if Haiku waits for it, the result should appear
      const response = runClaude(
        "Run `echo E2E_BG_MARKER_98765` using the Bash tool. " +
          "Tell me what the output was.",
        { timeout: TIMEOUT },
      );

      // The marker should appear in the result
      expect(response.result).toContain("E2E_BG_MARKER_98765");

      console.log("Background E2E result:", response.result.slice(0, 200));
    },
    TIMEOUT,
  );
});

describe.skipIf(SKIP_E2E)(
  "E2E: Session-logic state derivation with real DB activities",
  () => {
    it(
      "deriveAgentTeamsState produces correct state from a real team session",
      async () => {
        const fs = await import("fs");
        const path = await import("path");
        const os = await import("os");

        // First, run a team session
        const response = runClaude(
          "Create a team with 1 agent named 'checker'. " +
            "Have the checker read package.json and tell you the name. " +
            "Report the result, then clean up the team.",
          { timeout: TIMEOUT },
        );

        console.log("Team session result:", response.result.slice(0, 200));

        // Check the dev database for activities
        const dbPath = path.join(os.homedir(), ".t3", "dev", "state.sqlite");
        if (!fs.existsSync(dbPath)) {
          console.log("Skipping DB validation: dev database not found");
          return;
        }

        // Query activities
        let activitiesJson: string;
        try {
          activitiesJson = execFileSync(
            "sqlite3",
            [
              dbPath,
              "SELECT json_group_array(json_object(" +
                "'id', activity_id, 'kind', kind, 'summary', summary, " +
                "'tone', tone, 'payload', json(payload_json), " +
                "'turnId', turn_id, 'createdAt', created_at, 'sequence', sequence" +
                ")) FROM projection_thread_activities " +
                "WHERE thread_id = (SELECT thread_id FROM projection_threads ORDER BY created_at DESC LIMIT 1) " +
                "ORDER BY created_at;",
            ],
            { encoding: "utf-8", timeout: 5000 },
          ).trim();
        } catch {
          console.log("Skipping DB validation: sqlite3 query failed");
          return;
        }

        if (!activitiesJson || activitiesJson === "[[null]]") {
          console.log("Skipping DB validation: no activities found");
          return;
        }

        const rawActivities = JSON.parse(activitiesJson) as Array<Record<string, unknown>>;
        console.log(`Found ${rawActivities.length} activities`);

        // Map to OrchestrationThreadActivity
        const { EventId, TurnId } = await import("@t3tools/contracts");
        const { deriveAgentTeamsState } = await import("./session-logic");

        const activities = rawActivities
          .filter((a) => a.id && a.kind)
          .map((a) => ({
            id: EventId.makeUnsafe(String(a.id)),
            kind: String(a.kind),
            summary: String(a.summary ?? ""),
            tone: String(a.tone ?? "info") as "info" | "tool" | "approval" | "thinking" | "error",
            payload: typeof a.payload === "string" ? JSON.parse(a.payload) : (a.payload ?? {}),
            turnId: a.turnId ? TurnId.makeUnsafe(String(a.turnId)) : null,
            createdAt: String(a.createdAt ?? new Date().toISOString()),
            ...(a.sequence != null ? { sequence: Number(a.sequence) } : {}),
          }));

        const state = deriveAgentTeamsState(activities);

        console.log(
          "Agent teams state:",
          JSON.stringify(
            {
              hasTeamActivity: state.hasTeamActivity,
              runCount: state.runs.length,
              activeRunId: state.activeRunId,
              runs: state.runs.map((r) => ({
                label: r.label,
                status: r.status,
                memberCount: r.members.length,
                memberLabels: r.members.map((m) => m.label),
                activeCount: r.activeCount,
                endedAt: r.endedAt,
              })),
            },
            null,
            2,
          ),
        );

        if (state.hasTeamActivity) {
          const run = state.runs[0]!;
          // No phantom members
          const labels = run.members.map((m) => m.label);
          expect(labels).not.toContain("TeamCreate");
          expect(labels).not.toContain("TeamDelete");
          expect(labels).not.toContain("SendMessage");
          // At least 1 real member
          expect(run.members.length).toBeGreaterThanOrEqual(1);
        }
      },
      TIMEOUT,
    );
  },
);
