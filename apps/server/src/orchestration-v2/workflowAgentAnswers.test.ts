// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  parseWorkflowAgentTranscript,
  readWorkflowAgentTranscript,
} from "./workflowAgentAnswers.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

const assistant = (id: string, content: ReadonlyArray<unknown>) =>
  line({ type: "assistant", message: { role: "assistant", id, content } });

const parseAnswers = (contents: string) => parseWorkflowAgentTranscript(contents).answers;

describe("parseWorkflowAgentTranscript", () => {
  it("reads reported effort and speed from assistant records without text", () => {
    expect(
      parseWorkflowAgentTranscript(
        line({
          type: "assistant",
          effort: "xhigh",
          message: { id: "a", content: [], usage: { speed: "standard" } },
        }) + assistant("a", [{ type: "text", text: "Done" }]),
      ),
    ).toEqual({ answers: ["Done"], effort: "xhigh", speed: "standard" });
  });

  it("leaves unreported metadata absent and ignores bookkeeping and malformed values", () => {
    expect(
      parseWorkflowAgentTranscript(
        line({ type: "user", effort: "max", message: { usage: { speed: "fast" } } }) +
          line({ type: "assistant", isMeta: true, effort: "high" }) +
          line({
            type: "assistant",
            effort: 1,
            message: { id: "a", content: [], usage: { speed: false } },
          }) +
          assistant("a", [{ type: "text", text: "Done" }]),
      ),
    ).toEqual({ answers: ["Done"] });
  });

  it("clears metadata when a new assistant response omits it", () => {
    expect(
      parseWorkflowAgentTranscript(
        line({
          type: "assistant",
          effort: "max",
          message: { id: "a", content: [], usage: { speed: "standard" } },
        }) + assistant("b", [{ type: "text", text: "New response" }]),
      ),
    ).toEqual({ answers: ["New response"] });
  });
});

describe("parseWorkflowAgentTranscript answers", () => {
  it("returns one entry per assistant turn", () => {
    expect(
      parseAnswers(
        assistant("a", [{ type: "text", text: "first" }]) +
          assistant("b", [{ type: "text", text: "second" }]),
      ),
    ).toEqual(["first", "second"]);
  });

  it("joins the lines of one split assistant message into a single turn", () => {
    expect(
      parseAnswers(
        assistant("a", [{ type: "thinking", thinking: "weighing it up" }]) +
          assistant("a", [{ type: "text", text: "the answer" }]) +
          assistant("a", [{ type: "text", text: "and more" }]),
      ),
    ).toEqual(["the answer\n\nand more"]);
  });

  it("ignores harness bookkeeping and the member's own prompt", () => {
    expect(
      parseAnswers(
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
      parseAnswers(assistant("a", [{ type: "tool_use", id: "t", name: "Bash", input: {} }])),
    ).toEqual([]);
  });

  it("preserves answer indentation and ignores blank text", () => {
    expect(
      parseAnswers(
        assistant("a", [{ type: "text", text: "    indented code" }]) +
          assistant("b", [{ type: "text", text: "   " }]),
      ),
    ).toEqual(["    indented code"]);
  });

  it("survives a trailing line the byte cap cut in half", () => {
    expect(
      parseAnswers(
        assistant("a", [{ type: "text", text: "complete" }]) + '{"type":"assistant","mess',
      ),
    ).toEqual(["complete"]);
  });
});

let configDir: string;
let transcriptDir: string;
beforeAll(() => {
  configDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-config-"));
  transcriptDir = NodePath.join(configDir, "projects", "test");
  NodeFS.mkdirSync(transcriptDir, { recursive: true });
});

afterAll(() => {
  NodeFS.rmSync(configDir, { recursive: true, force: true });
});

describe("readWorkflowAgentTranscript", () => {
  effectIt.effect("reads final answers from both small and capped transcripts", () =>
    Effect.gen(function* () {
      const turn = assistant("a", [{ type: "text", text: "the answer" }]);
      const filler = line({ type: "user", message: { role: "user", content: "x".repeat(4096) } });
      const write = (agentId: string, contents: string) =>
        NodeFS.writeFileSync(NodePath.join(transcriptDir, `agent-${agentId}.jsonl`), contents);
      const read = (agentId: string) =>
        readWorkflowAgentTranscript({ transcriptDir, agentId, configDir }).pipe(
          Effect.map((transcript) => transcript.answers),
        );
      write("small", turn);
      const edgeAnswer = "x".repeat(
        512 * 1024 + 1 - Buffer.byteLength(assistant("edge", [{ type: "text", text: "" }])),
      );
      write("edge", assistant("edge", [{ type: "text", text: edgeAnswer }]));
      write(
        "boundary",
        filler.repeat(160) + turn + " ".repeat(512 * 1024 - Buffer.byteLength(turn)),
      );
      write(
        "huge",
        turn + filler.repeat(160) + assistant("final", [{ type: "text", text: "final answer" }]),
      );
      expect(yield* read("small")).toEqual(["the answer"]);
      expect(yield* read("edge")).toEqual([edgeAnswer]);
      expect(yield* read("huge")).toEqual(["final answer"]);
      expect(yield* read("boundary")).toEqual(["the answer"]);
    }),
  );
});
