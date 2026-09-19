// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { parseWorkflowAgentAnswers, readWorkflowAgentAnswers } from "./workflowAgentAnswers.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

const assistant = (id: string, content: ReadonlyArray<unknown>) =>
  line({ type: "assistant", message: { role: "assistant", id, content } });

describe("parseWorkflowAgentAnswers", () => {
  it("returns one entry per assistant turn", () => {
    expect(
      parseWorkflowAgentAnswers(
        assistant("a", [{ type: "text", text: "first" }]) +
          assistant("b", [{ type: "text", text: "second" }]),
      ),
    ).toEqual(["first", "second"]);
  });

  it("joins the lines of one split assistant message into a single turn", () => {
    expect(
      parseWorkflowAgentAnswers(
        assistant("a", [{ type: "thinking", thinking: "weighing it up" }]) +
          assistant("a", [{ type: "text", text: "the answer" }]) +
          assistant("a", [{ type: "text", text: "and more" }]),
      ),
    ).toEqual(["the answer\n\nand more"]);
  });

  it("ignores harness bookkeeping and the member's own prompt", () => {
    expect(
      parseWorkflowAgentAnswers(
        line({ type: "attachment", attachment: { type: "skill_listing", content: "- adhd" } }) +
          line({ type: "user", message: { role: "user", content: "the prompt" } }) +
          line({
            type: "assistant",
            isMeta: true,
            message: { role: "assistant", id: "m", content: [{ type: "text", text: "injected" }] },
          }) +
          assistant("a", [{ type: "text", text: "real answer" }]),
      ),
    ).toEqual(["real answer"]);
  });

  it("skips a turn that produced no text", () => {
    expect(
      parseWorkflowAgentAnswers(
        assistant("a", [{ type: "tool_use", id: "t", name: "Bash", input: {} }]),
      ),
    ).toEqual([]);
  });

  it("survives a trailing line the byte cap cut in half", () => {
    expect(
      parseWorkflowAgentAnswers(
        assistant("a", [{ type: "text", text: "complete" }]) + '{"type":"assistant","mess',
      ),
    ).toEqual(["complete"]);
  });
});

// Must sit under ~/.claude/projects: readContainedWorkflowFile rejects any path
// outside it, so a tmpdir would fail containment instead of exercising the read.
const root = NodePath.join(NodeOS.homedir(), ".claude", "projects", "__wf_answers_test__");
NodeFS.mkdirSync(root, { recursive: true });

afterAll(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("readWorkflowAgentAnswers", () => {
  // The under-cap case is the control: without it a read stuck on [] would pass.
  effectIt.effect("reads a transcript's turns, but none when the read was capped", () =>
    Effect.gen(function* () {
      const turn = assistant("a", [{ type: "text", text: "the answer" }]);
      const filler = line({ type: "user", message: { role: "user", content: "x".repeat(4096) } });
      NodeFS.writeFileSync(NodePath.join(root, "agent-small.jsonl"), turn);
      NodeFS.writeFileSync(NodePath.join(root, "agent-huge.jsonl"), turn + filler.repeat(160));
      expect(yield* readWorkflowAgentAnswers({ transcriptDir: root, agentId: "small" })).toEqual([
        "the answer",
      ]);
      expect(yield* readWorkflowAgentAnswers({ transcriptDir: root, agentId: "huge" })).toEqual([]);
    }),
  );
});
