import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AgentProfileRef } from "./agentRefs.ts";
import { ThreadCreatedPayload } from "./orchestration.ts";

const decodeAgentProfileRef = Schema.decodeUnknownSync(AgentProfileRef);
const decodeThreadCreatedPayload = Schema.decodeUnknownSync(ThreadCreatedPayload);

it("decodes pinned profile references and keeps historical thread payloads valid", () => {
  const profile = decodeAgentProfileRef({
    id: "reviewer",
    scope: "environment",
    revision: "a".repeat(64),
  });
  assert.deepEqual(profile, {
    id: "reviewer",
    scope: "environment",
    revision: "a".repeat(64),
  });

  const payload = decodeThreadCreatedPayload({
    threadId: "thread-agent-profile",
    projectId: "project-agent-profile",
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.isTrue(payload.agentProfile === undefined || payload.agentProfile === null);
});
