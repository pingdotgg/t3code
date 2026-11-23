import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readAntigravitySwarm } from "./AntigravitySwarm.ts";

const COORDINATOR = "e1eca26b-11b5-41f8-9d9b-bb8a692b2125";
const ADD_A = "a82657e1-5a66-4505-aecc-6844eec6d066";
const ADD_B = "60c330fe-87ec-457b-9fba-9e062cfc58d7";

const member = (conversationId: string, role: string, extra: object = {}) => ({
  conversation_id: conversationId,
  role,
  model: "gemini-3.8-flash-low",
  wake_mode: "mentions",
  killed: false,
  ...extra,
});

// Shapes captured from a real `agy` 1.5.14 `/swarm` run.
const writeSwarm = Effect.fn("writeSwarm")(function* (input: {
  readonly members: Record<string, object>;
  readonly board: ReadonlyArray<object>;
  readonly transcripts: Record<string, ReadonlyArray<object>>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profile = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-swarm-" });
  const brain = path.join(profile, "antigravity-acp", "brain");
  const swarm = path.join(brain, COORDINATOR, ".system_generated", "swarm");
  yield* fs.makeDirectory(swarm, { recursive: true });
  yield* fs.writeFileString(
    path.join(swarm, "members.json"),
    JSON.stringify({ title: "simple arithmetic addition", members: input.members }),
  );
  yield* fs.writeFileString(
    path.join(swarm, "board.jsonl"),
    input.board.map((post) => JSON.stringify(post)).join("\n") + "\n",
  );
  for (const [conversationId, steps] of Object.entries(input.transcripts)) {
    const logs = path.join(brain, conversationId, ".system_generated", "logs");
    yield* fs.makeDirectory(logs, { recursive: true });
    yield* fs.writeFileString(
      path.join(logs, "transcript.jsonl"),
      steps.map((step) => JSON.stringify(step)).join("\n") + "\n",
    );
  }
  return profile;
});

const briefs = [
  {
    seq: 1,
    agent: "coordinator",
    text: "@add-a Compute 2 + 3. Post @coordinator [done] 5 to the board.",
    time: "2026-11-23 17:23:18",
    kind: "brief",
  },
  {
    seq: 2,
    agent: "coordinator",
    text: "@add-b Compute 4 + 5. Post @coordinator [done] 9 to the board.",
    time: "2026-11-23 17:23:18",
    kind: "brief",
  },
];

const started = {
  step_index: 0,
  type: "SYSTEM_MESSAGE",
  status: "DONE",
  created_at: "2026-11-23T16:23:18Z",
};

const parked = [
  started,
  {
    step_index: 1,
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-11-23T16:23:18Z",
    input_tokens: 100,
    output_tokens: 20,
    tool_calls: [{ name: "post_message" }, { name: "swarm_wait" }],
  },
  { step_index: 2, type: "GENERIC", status: "DONE", created_at: "2026-11-23T16:23:21Z" },
  { step_index: 3, type: "GENERIC", status: "DONE", created_at: "2026-11-23T16:23:21Z" },
];

const working = [
  started,
  {
    step_index: 1,
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-11-23T16:23:19Z",
    tool_calls: [{ name: "run_command" }],
  },
];

it.layer(NodeServices.layer)("readAntigravitySwarm", (it) => {
  it.effect("shows each worker with its brief, state and [done] result", () =>
    Effect.gen(function* () {
      const profileDirectory = yield* writeSwarm({
        members: {
          "add-a": member(ADD_A, "worker"),
          "add-b": member(ADD_B, "worker"),
          coordinator: member(COORDINATOR, "coordinator"),
          narrator: member("bb91cb60-3240-44a0-a20d-966af04a49a3", "narrator"),
        },
        board: [
          ...briefs,
          { seq: 3, agent: "add-a", text: "@coordinator [done] 5", time: "2026-11-23 17:23:21" },
        ],
        transcripts: { [ADD_A]: parked, [ADD_B]: working },
      });
      const swarm = yield* readAntigravitySwarm({ profileDirectory, sessionId: COORDINATOR });
      expect(swarm?.active).toBe(true);
      expect(swarm?.head).toBe(3);
      expect(swarm?.workflow.name).toBe("simple arithmetic addition");
      expect(
        swarm?.workflow.agents.map(({ label, state, prompt, result, model, totalTokens }) => ({
          label,
          state,
          prompt,
          result,
          model,
          totalTokens,
        })),
      ).toEqual([
        {
          label: "add-a",
          state: "completed",
          prompt: "Compute 2 + 3. Post @coordinator [done] 5 to the board.",
          result: "@coordinator [done] 5",
          model: "gemini-3.8-flash-low",
          totalTokens: 120,
        },
        {
          label: "add-b",
          state: "running",
          prompt: "Compute 4 + 5. Post @coordinator [done] 9 to the board.",
          result: undefined,
          model: "gemini-3.8-flash-low",
          totalTokens: 0,
        },
      ]);
    }),
  );

  it.effect("ends when every worker parked, failed or was killed", () =>
    Effect.gen(function* () {
      const profileDirectory = yield* writeSwarm({
        members: {
          coordinator: member(COORDINATOR, "coordinator"),
          "add-a": member(ADD_A, "worker"),
          "add-b": member(ADD_B, "worker", { killed: true }),
        },
        board: briefs,
        transcripts: {
          [ADD_A]: [
            ...working,
            {
              step_index: 2,
              type: "ERROR_MESSAGE",
              status: "DONE",
              error: "RESOURCE_EXHAUSTED",
            },
          ],
          [ADD_B]: working,
        },
      });
      const swarm = yield* readAntigravitySwarm({ profileDirectory, sessionId: COORDINATOR });
      expect(swarm?.active).toBe(false);
      expect(swarm?.workflow.agents.map(({ state, result }) => ({ state, result }))).toEqual([
        { state: "failed", result: "RESOURCE_EXHAUSTED" },
        { state: "completed", result: undefined },
      ]);
    }),
  );

  it.effect("reads only the swarm this session coordinates", () =>
    Effect.gen(function* () {
      const profileDirectory = yield* writeSwarm({
        members: { coordinator: member(ADD_A, "coordinator") },
        board: [],
        transcripts: {},
      });
      expect(
        yield* readAntigravitySwarm({ profileDirectory, sessionId: COORDINATOR }),
      ).toBeUndefined();
      expect(yield* readAntigravitySwarm({ profileDirectory, sessionId: ADD_B })).toBeUndefined();
    }),
  );
});
