import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as EffectAcpSchema from "effect-acp/schema";

import {
  extractAntigravityUserInputQuestion,
  isAntigravityOpenCommand,
  antigravityApprovalOptions,
  isAntigravityUserInputRequest,
  makeAntigravityUserInputResponse,
  normalizeAntigravitySessionUpdate,
  normalizeAntigravityToolCall,
  sanitizeAntigravityToolPayload,
  selectAntigravityPermissionOptionId,
} from "./AntigravityProtocol.ts";
import { mergeToolCallState, parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";

const isSessionNotification = Schema.is(EffectAcpSchema.SessionNotification);

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

  it("uses only the option IDs offered for each approval decision", () => {
    expect(selectAntigravityPermissionOptionId(permissionRequest, "accept")).toBe("run-this-time");
    expect(selectAntigravityPermissionOptionId(permissionRequest, "acceptForSession")).toBe(
      "remember-this-command",
    );
    expect(selectAntigravityPermissionOptionId(permissionRequest, "acceptAlways")).toBe(
      "remember-this-command",
    );
    expect(selectAntigravityPermissionOptionId(permissionRequest, "decline")).toBe(
      "stop-this-command",
    );
    expect(selectAntigravityPermissionOptionId(permissionRequest, "cancel")).toBeUndefined();
  });

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

  it("does not replace unsupported remembered approval with a single approval", () => {
    const request = {
      ...permissionRequest,
      options: permissionRequest.options.filter((option) => option.kind !== "allow_always"),
    };
    expect(selectAntigravityPermissionOptionId(request, "acceptAlways")).toBeUndefined();
    expect(selectAntigravityPermissionOptionId(request, "acceptForSession")).toBeUndefined();
    expect(selectAntigravityPermissionOptionId(request, "accept")).toBe("run-this-time");
    expect(
      selectAntigravityPermissionOptionId({ ...request, options: [] }, "decline"),
    ).toBeUndefined();
  });

  it("routes the captured native question to single-choice input, not approval", () => {
    expect(isAntigravityUserInputRequest(questionRequest)).toBe(true);
    expect(selectAntigravityPermissionOptionId(questionRequest, "accept")).toBeUndefined();
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
    const request = {
      ...questionRequest,
      toolCall: { ...questionRequest.toolCall, title: "Question ".repeat(2_000) },
      options: [
        { optionId: "stable-choice", name: "Choice ".repeat(2_000), kind: "allow_once" as const },
      ],
    };
    const question = extractAntigravityUserInputQuestion(request);
    expect(question?.question.length).toBeLessThanOrEqual(8_000);
    expect(question?.options[0]?.label.length).toBeLessThanOrEqual(512);
    expect(question?.options[0]?.value).toBe("stable-choice");
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

  it("bounds both canonical output and retained raw output", () => {
    const output = `${"output line\n".repeat(20_000)}last line\n`;
    const event = parseToolUpdate({
      ...commandCompleted,
      update: {
        ...commandCompleted.update,
        rawOutput: {
          ...commandCompleted.update.rawOutput,
          combinedOutput: output,
          formatted_output: output,
        },
      },
    });
    const toolCall = normalizeAntigravityToolCall(event.toolCall);
    expect(toolCall.data).toMatchObject({
      item: { aggregatedOutput: expect.stringContaining("last line\n") },
      rawOutput: { combinedOutput: expect.stringContaining("last line\n") },
    });
    expect(JSON.stringify(toolCall).length).toBeLessThan(20_000);
    expect(JSON.stringify(event.rawPayload).length).toBeLessThan(10_000);
    expect(JSON.stringify(event.rawPayload)).not.toContain("formatted_output");
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
  });

  it("keeps large assistant replies and startup command metadata unchanged", () => {
    const notifications = [
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "a".repeat(20_000) },
        },
      },
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "plan", description: "Make a plan" }],
        },
      },
    ] satisfies ReadonlyArray<EffectAcpSchema.SessionNotification>;
    for (const notification of notifications) {
      expect(normalizeAntigravitySessionUpdate(notification)).toBe(notification);
    }
  });

  it("tracks only commands that have passed approval and are still running", () => {
    const running = normalizeAntigravityToolCall(parseToolUpdate(commandStarted).toolCall);
    expect(isAntigravityOpenCommand(running)).toBe(true);
    expect(isAntigravityOpenCommand({ ...running, status: "pending" })).toBe(false);
    expect(isAntigravityOpenCommand({ ...running, kind: "read" })).toBe(false);
    const completed = normalizeAntigravityToolCall(
      mergeToolCallState(running, parseToolUpdate(commandCompleted).toolCall),
    );
    expect(isAntigravityOpenCommand(completed)).toBe(false);
  });
});
