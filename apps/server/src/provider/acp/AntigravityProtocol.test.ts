import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as AcpWireSchema from "effect-acp/schema-v1";

import {
  extractAntigravityUserInputQuestion,
  antigravityApprovalOptions,
  antigravitySubagentOutput,
  antigravityToolOutlivesPrompt,
  classifyAntigravitySubagentToolCall,
  isAntigravityUserInputRequest,
  makeAntigravityUserInputResponse,
  normalizeAntigravitySessionUpdate,
  normalizeAntigravityToolCall,
  sanitizeAntigravityToolPayload,
  makeAntigravityReadRepair,
} from "./AntigravityProtocol.ts";
import {
  mergeToolCallState,
  parseSessionUpdateEvent,
} from "@t3tools/provider-acp/server/runtimeModel";
import { acpToolCallDiffPatch } from "@t3tools/provider-acp/server/adapter";
import { acpChangedPathsOfToolCall } from "@t3tools/provider-acp/server/clientPolicy";
import { MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH, toolOutputImages } from "@t3tools/shared/toolOutput";

const isSessionNotification = Schema.is(AcpWireSchema.SessionNotification);

describe("native Antigravity subagent tools", () => {
  it("recognizes only native invocation titles and excludes MCP tools", () => {
    const toolCall = { toolCallId: "trajectory:4", kind: "other", data: {} };
    for (const title of [
      "Running start_subagent",
      "Run start_subagent?",
      "Running invoke_subagent",
      "Run invoke_subagent?",
    ]) {
      expect(classifyAntigravitySubagentToolCall({ ...toolCall, title }, {})).toBe("subagent");
      expect(
        classifyAntigravitySubagentToolCall(
          { ...toolCall, title },
          { update: { _meta: { is_mcp_tool_call: true } } },
        ),
      ).toBe("mcp");
    }
    for (const title of [
      "Running subagent",
      "start_subagent",
      "Run command",
      "Running manage_task",
    ]) {
      expect(classifyAntigravitySubagentToolCall({ ...toolCall, title }, {})).toBeUndefined();
    }
    expect(
      classifyAntigravitySubagentToolCall(
        { ...toolCall, title: "Running start_subagent", kind: "execute" },
        {},
      ),
    ).toBeUndefined();
  });

  it("recognizes history starts and bounds the launch output", () => {
    expect(
      antigravitySubagentOutput({
        toolCallId: "trajectory:4",
        data: { rawOutput: "  Finished review.  " },
      }),
    ).toBe("Finished review.");
    const result = antigravitySubagentOutput({
      toolCallId: "trajectory:4",
      data: { rawOutput: `${"x".repeat(16_000)}The result.` },
    });
    expect(result?.length).toBeLessThan(8_100);
    expect(result?.endsWith("The result.")).toBe(true);
    expect(
      antigravitySubagentOutput({ toolCallId: "trajectory:4", data: { rawOutput: {} } }),
    ).toBeUndefined();
  });

  it("classifies swarm worker launches and formats legacy swarm board tools cleanly", () => {
    const addCall = normalizeAntigravityToolCall({
      toolCallId: "swarm-add-1",
      title: "Run swarm",
      kind: "other",
      status: "completed",
      data: {
        rawInput: { action: "add", name: "parser", brief: "Audit parser module" },
        rawOutput: { status: "added", name: "parser", conversation_id: "child-1" },
      },
    });
    expect(addCall.title).toBe("Add swarm worker @parser");
    expect(classifyAntigravitySubagentToolCall(addCall, {})).toBe("subagent");
    expect(
      classifyAntigravitySubagentToolCall(
        {
          toolCallId: "swarm-mcp",
          title: "Run swarm",
          kind: "other",
          data: { rawInput: { action: "add", name: "parser" } },
        },
        { update: { _meta: { is_mcp_tool_call: true } } },
      ),
    ).toBe("mcp");

    const killCall = normalizeAntigravityToolCall({
      toolCallId: "swarm-kill-1",
      title: "Run swarm",
      kind: "other",
      data: { rawInput: { action: "kill", name: "parser" } },
    });
    expect(killCall.title).toBe("Stop swarm worker @parser");
    expect(classifyAntigravitySubagentToolCall(killCall, {})).toBeUndefined();

    const postCall = normalizeAntigravityToolCall({
      toolCallId: "swarm-post-1",
      title: "Run post_message",
      kind: "other",
      data: { rawInput: { channel: "backend", text: "@coordinator done" } },
    });
    expect(postCall.title).toBe("Post to #backend");
    expect(classifyAntigravitySubagentToolCall(postCall, {})).toBeUndefined();

    const readCall = normalizeAntigravityToolCall({
      toolCallId: "swarm-read-1",
      title: "Run read_board",
      kind: "other",
      data: { rawInput: { since: 1 } },
    });
    expect(readCall.title).toBe("Read swarm board");
    expect(readCall.kind).toBe("other");

    const waitCall = normalizeAntigravityToolCall({
      toolCallId: "swarm-wait-1",
      title: "Run swarm_wait",
      kind: "other",
      data: { rawInput: { since: 2, wake_on: "mentions" } },
    });
    expect(waitCall.title).toBe("Wait for swarm board");
    expect(waitCall.kind).toBe("think");
  });
});

const questionRequest = {
  sessionId: "session-1",
  toolCall: {
    toolCallId: "interaction_9960062f",
    status: "pending",
    title: "Which result label should be used for the verification?",
    rawInput: {},
  },
  options: [
    { optionId: "1", name: "Verified", kind: "allow_once" },
    { optionId: "2", name: "Needs review", kind: "allow_once" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

const commandStarted = {
  sessionId: "session-1",
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "fc28d0af6ad14be8bbba20f4258d4d3e",
    title: "run_command",
    kind: "execute",
    status: "in_progress",
    rawInput: { CommandLine: "cat probe.txt", Cwd: "/workspace" },
  },
} satisfies EffectAcpSchema.SessionNotification;

const commandCompleted = {
  sessionId: "session-1",
  update: {
    toolCallId: commandStarted.update.toolCallId,
    status: "completed",
    rawOutput: {
      commandLine: "cat probe.txt",
      workingDir: "/workspace",
      exitCode: 0,
      exit_code: 0,
      combinedOutput: "after\n",
      formatted_output: "after\n",
    },
    sessionUpdate: "tool_call_update",
  },
} satisfies EffectAcpSchema.SessionNotification;

function parseToolUpdate(notification: EffectAcpSchema.SessionNotification) {
  const result = parseSessionUpdateEvent(normalizeAntigravitySessionUpdate(notification));
  const event = result.events[0];
  if (event?._tag !== "ToolCallUpdated") {
    throw new Error("Expected a tool update.");
  }
  return event;
}

describe("Antigravity permissions and questions", () => {
  const permissionRequest = {
    sessionId: "session-1",
    toolCall: { toolCallId: "command-1", kind: "execute", title: "Run command" },
    options: [
      { optionId: "remember-this-command", name: "Allow always", kind: "allow_always" },
      { optionId: "run-this-time", name: "Allow", kind: "allow_once" },
      { optionId: "stop-this-command", name: "Deny", kind: "reject_once" },
    ],
  } satisfies EffectAcpSchema.RequestPermissionRequest;

  it("surfaces the agent's prompt injection warning on the remembered approval", () => {
    const risky = {
      ...permissionRequest,
      options: [
        {
          optionId: "remember-this-command",
          name: "Allow Always (risky)",
          kind: "allow_always",
          _meta: {
            "agy.security.warning": {
              severity: "high",
              risk: "prompt_injection",
              title: "Allowing always can be risky",
              message: "Untrusted files could re-run this action without asking.",
            },
          },
        },
        { optionId: "run-this-time", name: "Allow", kind: "allow_once" },
        { optionId: "stop-this-command", name: "Deny", kind: "reject_once" },
      ],
    } satisfies EffectAcpSchema.RequestPermissionRequest;
    expect(antigravityApprovalOptions(risky)).toEqual([
      { decision: "accept", label: "Allow once" },
      {
        decision: "acceptForSession",
        label: "Allow for this thread",
        warning: "Untrusted files could re-run this action without asking.",
      },
      { decision: "decline", label: "Deny" },
      { decision: "cancel", label: "Cancel" },
    ]);
    expect(antigravityApprovalOptions(permissionRequest)[1]).not.toHaveProperty("warning");
  });

  it("routes the captured native question to single-choice input, not approval", () => {
    expect(isAntigravityUserInputRequest(questionRequest)).toBe(true);
    expect(extractAntigravityUserInputQuestion(questionRequest)).toEqual({
      id: "interaction_9960062f",
      header: "Question",
      question: "Which result label should be used for the verification?",
      multiSelect: false,
      allowCustomAnswer: false,
      options: [
        { value: "1", label: "Verified", description: "Verified" },
        { value: "2", label: "Needs review", description: "Needs review" },
      ],
    });
    expect(extractAntigravityUserInputQuestion(permissionRequest)).toBeUndefined();
  });

  it("returns exact opaque IDs and accepts a unique label from an older client", () => {
    for (const answer of ["1", ["1"], "Verified"]) {
      expect(
        makeAntigravityUserInputResponse(questionRequest, { interaction_9960062f: answer }),
      ).toEqual({ outcome: { outcome: "selected", optionId: "1" } });
    }
    const request = {
      ...questionRequest,
      options: [{ optionId: " choice: opaque ", name: "Keep", kind: "allow_once" as const }],
    };
    expect(
      makeAntigravityUserInputResponse(request, { interaction_9960062f: " choice: opaque " }),
    ).toEqual({ outcome: { outcome: "selected", optionId: " choice: opaque " } });
  });

  it("does not treat a question's reject choice as cancellation", () => {
    const request = {
      ...questionRequest,
      options: [{ optionId: "deny", name: "Do not trust", kind: "reject_once" as const }],
    };
    expect(makeAntigravityUserInputResponse(request, { interaction_9960062f: "deny" })).toEqual({
      outcome: { outcome: "selected", optionId: "deny" },
    });
  });

  it("preserves duplicate labels and rejects ambiguous label answers", () => {
    const request = {
      ...questionRequest,
      options: questionRequest.options.map((option) => ({ ...option, name: "Same label" })),
    };
    expect(
      extractAntigravityUserInputQuestion(request)?.options.map((option) => option.value),
    ).toEqual(["1", "2"]);
    expect(
      makeAntigravityUserInputResponse(request, { interaction_9960062f: "Same label" }),
    ).toBeUndefined();
    expect(makeAntigravityUserInputResponse(request, { interaction_9960062f: "2" })).toEqual({
      outcome: { outcome: "selected", optionId: "2" },
    });
  });

  it.each([undefined, null, "", "arbitrary answer", [], ["1", "2"], { answer: "1" }, 1])(
    "keeps the question open for an unsupported answer: %j",
    (answer) => {
      expect(
        makeAntigravityUserInputResponse(questionRequest, { interaction_9960062f: answer }),
      ).toBeUndefined();
    },
  );

  it("rejects missing or duplicate native option IDs", () => {
    for (const optionId of ["", "1"]) {
      const request = {
        ...questionRequest,
        options: [questionRequest.options[0]!, { ...questionRequest.options[1]!, optionId }],
      };
      expect(extractAntigravityUserInputQuestion(request)).toBeUndefined();
      expect(
        makeAntigravityUserInputResponse(request, { interaction_9960062f: "1" }),
      ).toBeUndefined();
    }
  });

  it("bounds question text without changing choice IDs", () => {
    const title = "Q".repeat(7_994) + "🧪";
    const label = "O".repeat(506) + "🧪";
    const request = {
      ...questionRequest,
      toolCall: { ...questionRequest.toolCall, title: title + "🚀 continued" },
      options: [
        { optionId: "stable-choice", name: label + "🚀 continued", kind: "allow_once" as const },
      ],
    };
    const question = extractAntigravityUserInputQuestion(request);
    expect(question?.question).toBe(title + "...");
    expect(question?.options).toEqual([
      { value: "stable-choice", label: label + "...", description: label + "..." },
    ]);
    expect(
      makeAntigravityUserInputResponse(request, { interaction_9960062f: label + "..." }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "stable-choice" } });
  });
});

describe("Antigravity tool results", () => {
  it("normalizes the captured command and completed output for the existing clients", () => {
    const initial = parseToolUpdate(commandStarted).toolCall;
    const completed = parseToolUpdate(commandCompleted).toolCall;
    const toolCall = normalizeAntigravityToolCall(mergeToolCallState(initial, completed));

    expect(toolCall).toMatchObject({
      kind: "execute",
      status: "completed",
      command: "cat probe.txt",
      detail: "cat probe.txt",
      data: {
        command: "cat probe.txt",
        cwd: "/workspace",
        item: {
          command: "cat probe.txt",
          cwd: "/workspace",
          aggregatedOutput: "after\n",
          exitCode: 0,
        },
      },
    });
    expect(toolCall.data.rawOutput).not.toHaveProperty("formatted_output");
    expect(commandCompleted.update.rawOutput.formatted_output).toBe("after\n");
  });

  it("keeps the captured edit location through approval and completion", () => {
    const path = "/workspace/app.ts";
    const replace = {
      TargetContent: "const target = 10;",
      ReplacementContent: "const target = 100;",
      TargetFile: path,
    };
    const frame = (rawInput: Record<string, unknown>, line?: number) =>
      ({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "edit-1",
          title: "Run edit_file?",
          kind: "edit",
          status: "pending",
          content: [
            {
              type: "diff",
              path,
              oldText: replace.TargetContent,
              newText: replace.ReplacementContent,
            },
          ],
          locations: [line === undefined ? { path } : { path, line }],
          rawInput,
        },
      }) satisfies EffectAcpSchema.SessionNotification;
    const running = parseToolUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        kind: "edit",
        status: "in_progress",
        title: "Running edit_file",
        locations: [{ path }],
        rawInput: { file_path: path },
      },
    }).toolCall;
    const completed = parseToolUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "completed",
        rawOutput: "Tool execution",
      },
    }).toolCall;
    const preEdit = Array.from({ length: 12 }, (_, i) =>
      i === 9 ? replace.TargetContent : `line ${i + 1}`,
    ).join("\n");
    const postEdit = preEdit.replace(replace.TargetContent, replace.ReplacementContent);
    for (const [pending, readFile] of [
      [frame({ ...replace, StartLine: 5, EndLine: 12 }, 5), () => preEdit],
      [frame(replace), () => preEdit],
    ] as const) {
      let toolCall = normalizeAntigravityToolCall(parseToolUpdate(pending).toolCall, readFile);
      for (const next of [running, completed]) {
        toolCall = normalizeAntigravityToolCall(mergeToolCallState(toolCall, next), () => postEdit);
      }
      expect(toolCall.status).toBe("completed");
      expect(acpToolCallDiffPatch(toolCall.data.content)).toBe(
        `--- ${path}\n+++ ${path}\n@@ -10,1 +10,1 @@\n-const target = 10;\n+const target = 100;\n`,
      );
    }
    // Full-access edits arrive path-only; no hunk is offered instead of the tool's status text.
    let pathOnly = normalizeAntigravityToolCall(
      parseToolUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "edit-2",
          kind: "edit",
          status: "in_progress",
          title: "Running edit_file",
          locations: [{ path }],
          rawInput: { file_path: path },
        },
      }).toolCall,
    );
    pathOnly = normalizeAntigravityToolCall(mergeToolCallState(pathOnly, completed));
    expect(pathOnly.data.content).toEqual([{ type: "diff", patch: { format: "omitted" } }]);
    expect(acpToolCallDiffPatch(pathOnly.data.content)).toBeUndefined();
    // A captured patch that a later update's shared text budget cut or dropped is omitted.
    for (const patch of [{ text: "[Earlier output truncated]\n\n@@ -80,1 +80,1 @@" }, {}]) {
      const kept = normalizeAntigravityToolCall({
        toolCallId: "edit-cut",
        kind: "edit",
        status: "completed",
        data: { content: [{ type: "diff", path, patch }] },
      });
      expect(kept.data.content).toEqual([{ type: "diff", path, patch: { format: "omitted" } }]);
    }
    // A whole-file write whose old text was cut to its tail must not show the cut as deletions.
    const overwrite = normalizeAntigravityToolCall({
      toolCallId: "edit-overwrite",
      kind: "edit",
      status: "completed",
      data: {
        rawInput: { TargetFile: path, CodeContent: "one line\n" },
        content: [
          {
            type: "diff",
            path,
            oldText: "[Earlier output truncated]\n\nrow 999\n",
            newText: "one line\n",
          },
        ],
      },
    });
    expect(acpToolCallDiffPatch(overwrite.data.content)).toBeUndefined();
    // A patch too long to keep, or input cut to its tail, must not fall back to line-1 snippets.
    for (const width of [60, 120]) {
      const block = (value: string) =>
        Array.from({ length: 120 }, (_, i) => `${value} ${i} `.padEnd(width, "x")).join("\n");
      const long = {
        TargetContent: block("old"),
        ReplacementContent: block("new"),
        TargetFile: path,
      };
      const toolCall = normalizeAntigravityToolCall(
        parseToolUpdate(frame({ ...long, StartLine: 80, EndLine: 199 }, 80)).toolCall,
      );
      expect(toolCall.data.content).toMatchObject([{ patch: { format: "omitted" } }]);
      expect(acpToolCallDiffPatch(toolCall.data.content)).toBeUndefined();
    }
  });

  it.each([
    { CommandLine: "pwd", Cwd: "/one" },
    { CommandLine: "pwd", WorkingDirectory: "/one" },
    { command_line: "pwd", working_dir: "/one" },
    { commandLine: "pwd", workingDir: "/one" },
    { command: "pwd", cwd: "/one" },
  ])("handles native command input aliases: %j", (rawInput) => {
    const event = parseToolUpdate({
      ...commandStarted,
      update: { ...commandStarted.update, rawInput },
    });
    expect(normalizeAntigravityToolCall(event.toolCall)).toMatchObject({
      command: "pwd",
      detail: "pwd",
      data: { item: { command: "pwd", cwd: "/one" } },
    });
  });

  it("recovers command fields from history and keeps nonzero exits separate from tool failure", () => {
    const event = parseToolUpdate({
      ...commandCompleted,
      update: {
        ...commandCompleted.update,
        rawOutput: {
          command_line: "test -f missing.txt",
          working_dir: "/workspace",
          combined_output: "",
          exit_code: 1,
        },
      },
    });
    expect(normalizeAntigravityToolCall(event.toolCall)).toMatchObject({
      kind: "execute",
      status: "completed",
      command: "test -f missing.txt",
      data: { item: { cwd: "/workspace", aggregatedOutput: "", exitCode: 1 } },
    });
  });

  it.each([
    { name: "ASCII", boundary: "x", kept: "x", field: "combinedOutput" },
    { name: "split emoji", boundary: "🚀", kept: "", field: "combinedOutput" },
    { name: "split emoji (snake case)", boundary: "🚀", kept: "", field: "combined_output" },
  ])("bounds both canonical and retained raw output at $name", ({ boundary, kept, field }) => {
    const tail = `${"x".repeat(7_989)}last line\n`;
    const output = `${"output line\n".repeat(20_000)}${boundary}${tail}`;
    const expected = `[Earlier output truncated]\n\n${kept}${tail}`;
    const { combinedOutput: _combinedOutput, ...rawOutput } = commandCompleted.update.rawOutput;
    const event = parseToolUpdate({
      ...commandCompleted,
      update: {
        ...commandCompleted.update,
        rawOutput: {
          ...rawOutput,
          [field]: output,
          formatted_output: output,
        },
      },
    });
    const toolCall = normalizeAntigravityToolCall(event.toolCall);
    expect(toolCall.data).toMatchObject({
      item: { aggregatedOutput: expected },
      rawOutput: { [field]: expected },
    });
    expect(event.toolCall.data.rawOutput).toMatchObject({ [field]: expected });
    expect(JSON.stringify(toolCall).length).toBeLessThan(20_000);
    expect(JSON.stringify(event.rawPayload).length).toBeLessThan(10_000);
    expect(JSON.stringify(event.rawPayload)).not.toContain("formatted_output");
  });

  it.each([
    { name: "a command", update: commandStarted.update, outlives: true },
    {
      name: "a daemon",
      update: { ...commandStarted.update, rawInput: { CommandLine: "serve", IsDaemon: true } },
      outlives: false,
    },
    // agy 1.5.13 keeps this call in progress until the wake fires.
    {
      name: "a scheduled wake",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_4902666363527503248",
        status: "in_progress",
        kind: "other",
        title: "Run schedule",
        rawInput: { DurationSeconds: 30, Prompt: "Reply only with the word DONE." },
      },
      outlives: true,
    },
    {
      name: "another native tool",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_other",
        status: "in_progress",
        kind: "other",
        title: "Run list_dir",
        rawInput: { DirectoryPath: "/workspace" },
      },
      outlives: false,
    },
  ] satisfies ReadonlyArray<{
    name: string;
    update: EffectAcpSchema.SessionNotification["update"];
    outlives: boolean;
  }>)("knows whether $name outlives the prompt", ({ update, outlives }) => {
    const event = parseToolUpdate({ sessionId: "session-1", update });
    expect(antigravityToolOutlivesPrompt(normalizeAntigravityToolCall(event.toolCall))).toBe(
      outlives,
    );
  });

  it("keeps the start of a long command line, where the program and target are", () => {
    const head = "cat > notes.md <<'EOF'";
    const commandLine = `${head}\n${"note line\n".repeat(1_000)}EOF`;
    const toolCall = normalizeAntigravityToolCall(
      parseToolUpdate({
        ...commandStarted,
        update: { ...commandStarted.update, rawInput: { CommandLine: commandLine } },
      }).toolCall,
    );
    expect(toolCall.command?.startsWith(head)).toBe(true);
    expect(toolCall.command).not.toContain("[Earlier output truncated]");
    expect((toolCall.data.rawInput as { CommandLine: string }).CommandLine.startsWith(head)).toBe(
      true,
    );
  });

  it("keeps 1.5 command input and output valid Unicode when cut", () => {
    const tail = `${"x".repeat(7_982)}build completed\r\n`;
    const output = `Command output:\nprefix\r\n🚀${tail}`;
    const expected = `[Earlier output truncated]\n\n${tail}`;
    const head = "x".repeat(7_999);
    const expectedCommand = `${head}\n\n[Command truncated]`;
    const toolCall = normalizeAntigravityToolCall(
      parseToolUpdate({
        ...commandCompleted,
        update: {
          ...commandCompleted.update,
          rawInput: { CommandLine: `${head}🚀 --flag` },
          rawOutput: { output, exit_code: 0 },
          content: [{ type: "content", content: { type: "text", text: output } }],
        },
      }).toolCall,
    );
    expect(toolCall.command).toBe(expectedCommand);
    expect(toolCall.data).toMatchObject({
      rawInput: { CommandLine: expectedCommand },
      rawOutput: { output: expected },
      content: [{ content: { text: expected.trimEnd() } }],
    });
  });

  it("removes inline images while preserving valid tool content and the local image path", () => {
    const inlineImage = "inline-image-bytes".repeat(50_000);
    const notification = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "image-1",
        status: "completed",
        rawOutput: { imageName: "result", imagePath: "file:///workspace/brain/result%20image.png" },
        content: [
          { type: "content", content: { type: "image", mimeType: "image/png", data: inlineImage } },
          { type: "content", content: { type: "text", text: "Saved the image." } },
          { type: "diff", path: "/workspace/note.txt", oldText: "old", newText: "new" },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification;
    const normalized = normalizeAntigravitySessionUpdate(notification);
    expect(isSessionNotification(normalized)).toBe(true);
    expect(JSON.stringify(normalized)).not.toContain("inline-image-bytes");
    expect(normalized.update).toMatchObject({
      content: [
        { type: "content", content: { type: "text", text: "Saved the image." } },
        { type: "diff", path: "/workspace/note.txt", oldText: "old", newText: "new" },
      ],
    });
    expect(normalizeAntigravityToolCall(parseToolUpdate(normalized).toolCall).data.imagePath).toBe(
      "/workspace/brain/result image.png",
    );
  });

  it("keeps bounded screenshot bytes from T3 MCP tool results", () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    const tooLarge = "A".repeat(MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH + 4);
    const notification = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "shot-1",
        status: "completed",
        rawOutput: {
          content: [
            { type: "image", mimeType: "image/png", data: png },
            { type: "image", mimeType: "image/png", data: tooLarge },
            { type: "text", text: JSON.stringify({ url: "https://example.test/" }) },
          ],
        },
        content: [
          { type: "content", content: { type: "image", mimeType: "image/png", data: png } },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification;
    const normalized = normalizeAntigravitySessionUpdate(notification);
    expect(isSessionNotification(normalized)).toBe(true);
    const update = parseToolUpdate(normalized).toolCall.data;
    expect(toolOutputImages(update.rawOutput)).toEqual([
      { mimeType: "image/png", data: png },
      { mimeType: "image/png" },
    ]);
    expect(normalized.update).toMatchObject({
      content: [{ type: "content", content: { type: "image", mimeType: "image/png", data: png } }],
    });
  });

  const changesBeyondSizeLimits: ReadonlyArray<{
    readonly part: string;
    readonly update: Pick<EffectAcpSchema.ToolCallUpdate, "content" | "rawInput">;
  }> = [
    {
      part: "a diff after others whose text uses up the size limit",
      update: {
        content: [
          ...Array.from({ length: 5 }, (_, index) => ({
            type: "diff" as const,
            path: `/workspace/a${index}.ts`,
            newText: "a".repeat(9_000),
          })),
          { type: "diff", path: "/elsewhere/b.ts", newText: "b" },
        ],
      },
    },
    {
      part: "a diff whose path is longer than the size limit",
      update: {
        content: [{ type: "diff", path: `/elsewhere/${"d".repeat(9_000)}/b.ts`, newText: "b" }],
      },
    },
    {
      part: "a raw input path after text that uses up the size limit",
      update: {
        rawInput: {
          first: "a".repeat(8_000),
          parts: Array.from({ length: 8 }, () => "a".repeat(8_000)),
          file_path: "/elsewhere/b.ts",
        },
      },
    },
    {
      part: "a raw input path longer than the size limit",
      update: { rawInput: { path: `/elsewhere/${"d".repeat(9_000)}/b.ts` } },
    },
  ];
  it.each(changesBeyondSizeLimits)(
    "keeps every path a file change names, or none: $part",
    ({ update }) => {
      const notification: EffectAcpSchema.SessionNotification = {
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-1",
          title: "Edit files",
          kind: "edit",
          status: "pending",
          ...update,
        },
      };
      const sent = acpChangedPathsOfToolCall(update);
      const normalized = normalizeAntigravitySessionUpdate(notification).update;
      if (normalized.sessionUpdate !== "tool_call_update") {
        return expect.unreachable("a tool call update stays one");
      }
      const kept = acpChangedPathsOfToolCall(normalized);
      expect(sent).not.toBe("unknown");
      if (kept !== "unknown") expect(kept).toEqual(sent);
    },
  );

  it.each([
    ["/workspace/result.png", "/workspace/result.png"],
    ["C:\\work\\result.png", "C:\\work\\result.png"],
    ["file:///C:/work/result.png", "C:/work/result.png"],
    ["https://example.com/result.png", undefined],
    ["file://another-host/result.png", undefined],
    ["data:image/png;base64,AAAA", undefined],
  ])("only promotes local image references: %s", (imagePath, expected) => {
    const toolCall = normalizeAntigravityToolCall({
      toolCallId: "image-1",
      data: { rawOutput: { imagePath } },
    });
    expect(toolCall.data.imagePath).toBe(expected);
  });

  it("bounds nested tool data and drops image blobs and data URLs", () => {
    const payload = sanitizeAntigravityToolPayload({
      rawOutput: {
        text: "a".repeat(100_000),
        result: { mimeType: "image/png", blob: "image-blob".repeat(100_000) },
        image: { type: "image", data: "inline-image".repeat(100_000) },
        uri: "data:image/png;base64,inline-data-url",
      },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized.length).toBeLessThan(9_000);
    expect(serialized).not.toContain("image-blob");
    expect(serialized).not.toContain("inline-image");
    expect(serialized).not.toContain("inline-data-url");

    // Leave three UTF-16 units for the retained output.
    const padding = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [index, "x".repeat(8_000)]),
    );
    expect(
      sanitizeAntigravityToolPayload({
        rawOutput: { ...padding, tail: "x".repeat(7_997) },
        item: { aggregatedOutput: "🚀ok" },
      }),
    ).toMatchObject({ item: { aggregatedOutput: "[Earlier output truncated]\n\nok" } });
  });
});

describe("Antigravity served reads", () => {
  const flush = (reads: ReturnType<typeof makeAntigravityReadRepair>, toolCallId: string) =>
    reads.repair({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: "Tool execution failed",
      },
    }).update;

  it("credits a read T3 served before the agent announced it", () => {
    const reads = makeAntigravityReadRepair();
    reads.attempted("/repo/a.ts", true);
    const announced = reads.repair({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_late",
        title: "Running client_view_file",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "/repo/a.ts" }],
      },
    });
    expect(announced.update).toMatchObject({ status: "completed" });
    expect(flush(reads, "call_late")).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_late",
      status: "completed",
    });
  });

  it("forgets an earlier turn's unannounced served read", () => {
    const reads = makeAntigravityReadRepair();
    reads.attempted("/repo/a.ts", true);
    reads.reset();
    reads.repair({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_refused",
        title: "Running client_view_file",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "/repo/a.ts" }],
      },
    });
    reads.attempted("/repo/a.ts", false);
    expect(flush(reads, "call_refused")).toMatchObject({ status: "failed" });
  });

  it("drops an earlier turn's unanswered read so a new turn's served read gets the credit", () => {
    const reads = makeAntigravityReadRepair();
    const announce = (toolCallId: string) =>
      reads.repair({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Running client_view_file",
          kind: "read",
          status: "in_progress",
          locations: [{ path: "/repo/a.ts" }],
        },
      });
    announce("call_abandoned");
    reads.reset();
    announce("call_current");
    reads.attempted("/repo/a.ts", true);
    expect(flush(reads, "call_current")).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_current",
      status: "completed",
    });
  });

  it("drops agy's toolSummary from T3 MCP call arguments only", () => {
    const t3Call = normalizeAntigravityToolCall(
      parseToolUpdate(
        normalizeAntigravitySessionUpdate({
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_t3_send",
            title: "Run mcp_t3-code_send_to_user",
            kind: "other",
            status: "in_progress",
            rawInput: { message: "Hello", toolSummary: "Send greeting" },
          },
        }),
      ).toolCall,
    );
    expect(t3Call.data.rawInput).toEqual({ message: "Hello" });

    const proxiedT3Call = normalizeAntigravityToolCall(
      parseToolUpdate(
        normalizeAntigravitySessionUpdate({
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_t3_proxy_send",
            title: "Run mcp_t3-code_tool_call",
            kind: "other",
            status: "in_progress",
            rawInput: {
              name: "send_to_user",
              arguments: { message: "Hello", toolSummary: "Nested summary" },
              toolSummary: "Outer summary",
            },
          },
        }),
      ).toolCall,
    );
    expect(proxiedT3Call.data.rawInput).toEqual({
      name: "send_to_user",
      arguments: { message: "Hello" },
    });

    const callMcpProxiedT3Call = normalizeAntigravityToolCall(
      parseToolUpdate(
        normalizeAntigravitySessionUpdate({
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_t3_call_mcp_proxy_send",
            title: "MCP Tool tool_call",
            kind: "execute",
            status: "in_progress",
            rawInput: {
              ServerName: "t3-code",
              ToolName: "tool_call",
              Arguments: {
                name: "send_to_user",
                arguments: { message: "Hello", toolSummary: "Nested summary" },
                toolSummary: "Outer summary",
              },
            },
          },
        }),
      ).toolCall,
    );
    expect(callMcpProxiedT3Call.data.rawInput).toEqual({
      ServerName: "t3-code",
      ToolName: "tool_call",
      Arguments: {
        name: "send_to_user",
        arguments: { message: "Hello" },
      },
    });

    const foreignCall = normalizeAntigravityToolCall(
      parseToolUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_other",
          title: "Run mcp_other_send_to_user",
          kind: "other",
          status: "in_progress",
          rawInput: { message: "Hello", toolSummary: "Send greeting" },
        },
      }).toolCall,
    );
    expect(foreignCall.data.rawInput).toEqual({ message: "Hello", toolSummary: "Send greeting" });
  });
});

describe("Antigravity command toolSummary normalization", () => {
  it("uses rawInput toolSummary when the command carries a generic title", () => {
    const normalized = normalizeAntigravityToolCall({
      toolCallId: "call_cmd_1",
      title: "Run command",
      kind: "execute",
      status: "inProgress",
      data: {
        rawInput: {
          CommandLine: "mkdir -p /tmp/out && python3 capture.py",
          toolSummary: "Check outer moons sky level and capture 60 frames if clean",
        },
      },
    });
    expect(normalized.title).toBe("Check outer moons sky level and capture 60 frames if clean");

    const preserved = normalizeAntigravityToolCall({
      toolCallId: "call_cmd_2",
      title: "Already named task",
      kind: "execute",
      status: "inProgress",
      data: {
        rawInput: {
          CommandLine: "echo hi",
          tool_summary: "Fallback summary",
        },
      },
    });
    expect(preserved.title).toBe("Already named task");
  });
});
