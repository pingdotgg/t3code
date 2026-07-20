import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import {
  extractXAiAcpBackgroundToolMutation,
  extractXAiAcpSubagentEndNotice,
  extractXAiAcpSubagentUpdate,
  extractXAiAskUserQuestions,
  extractXAiBackgroundTaskCompletion,
  extractXAiKilledBackgroundTasks,
  extractXAiMonitorTaskId,
  isGenericAcpToolTitle,
  isXAiMonitorTool,
  isXAiPersistentMonitor,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  makeXAiPromptCompletionRuntime,
  normalizeXAiAcpToolCallState,
  resolveXAiAcpToolTitle,
  xAiBackgroundTaskLifecycleMutation,
  xAiPromptCompleteFromSessionUpdate,
  XAiAskUserQuestionRequest,
} from "./XAiAcpExtension.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const decodeXAiAskUserQuestionRequest = Schema.decodeUnknownSync(XAiAskUserQuestionRequest);

describe("xAiPromptCompleteFromSessionUpdate", () => {
  it("maps live turn_completed snake_case payloads", () => {
    expect(
      xAiPromptCompleteFromSessionUpdate({
        sessionId: "019f4428-4bf1-7e52-b7c6-c29b506543b1",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "t3-xai-prompt-1",
          stop_reason: "end_turn",
        },
      }),
    ).toEqual({
      sessionId: "019f4428-4bf1-7e52-b7c6-c29b506543b1",
      promptId: "t3-xai-prompt-1",
      stopReason: "end_turn",
    });
  });

  it("ignores non-turn updates and task-completed prompt ids", () => {
    expect(
      xAiPromptCompleteFromSessionUpdate({
        sessionId: "root",
        update: { sessionUpdate: "hook_execution", prompt_id: "t3-xai-prompt-1" },
      }),
    ).toBeNull();
    expect(
      xAiPromptCompleteFromSessionUpdate({
        sessionId: "root",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "task-completed-call-abc",
          stop_reason: "end_turn",
        },
      }),
    ).toBeNull();
    expect(
      xAiPromptCompleteFromSessionUpdate({
        sessionId: "root",
        update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" },
      }),
    ).toBeNull();
  });
});

describe("XAiAcpExtension", () => {
  it("recognizes Grok Task starts as native subagents", () => {
    expect(
      extractXAiAcpSubagentUpdate({
        toolCallId: "task-1",
        title: "Task",
        status: "inProgress",
        data: {
          rawInput: {
            description: "Explore server architecture",
            prompt: "Audit apps/server.",
            subagent_type: "generalPurpose",
            model: "composer-2.5-fast",
          },
        },
      }),
    ).toEqual({
      nativeTaskId: "task-1",
      prompt: "Audit apps/server.",
      title: "Explore server architecture",
      model: "composer-2.5-fast",
      status: "running",
      childSessionId: null,
      result: null,
      suppressNormalTool: true,
    });
  });

  it("extracts Grok child session lineage from completed Task output", () => {
    expect(
      extractXAiAcpSubagentUpdate({
        toolCallId: "task-1",
        title: "Task",
        status: "completed",
        data: {
          rawInput: {
            description: "Explore server architecture",
            prompt: "Audit apps/server.",
            subagent_type: "generalPurpose",
          },
          rawOutput: {
            type: "Text",
            text: [
              "Server audit complete.",
              "",
              "Agent ID: 019f0220-e192-7c41-9e9d-b406bc3459c8 (resume supported)",
            ].join("\n"),
          },
        },
      }),
    ).toEqual({
      nativeTaskId: "task-1",
      prompt: "Audit apps/server.",
      title: "Explore server architecture",
      model: null,
      status: "completed",
      childSessionId: "019f0220-e192-7c41-9e9d-b406bc3459c8",
      result: "Server audit complete.",
      suppressNormalTool: true,
    });
  });

  it("keeps async spawn_subagent ACKs running and binds subagent_id", () => {
    expect(
      extractXAiAcpSubagentUpdate({
        toolCallId: "call-spawn-1",
        title: "spawn_subagent",
        status: "completed",
        data: {
          rawInput: {
            description: "Demo subagent wait and ls",
            prompt: "Wait then ls.",
            subagent_type: "general-purpose",
          },
          rawOutput: {
            type: "Text",
            text: [
              "Subagent started in background.",
              "subagent_id: 019f44a6-4820-7402-925d-bc862ee711dd",
              "type: general-purpose",
              "description: Demo subagent wait and ls",
              "",
              'Use get_command_or_subagent_output with task_ids=["019f44a6-4820-7402-925d-bc862ee711dd"] and timeout_ms to wait for results.',
            ].join("\n"),
          },
        },
      }),
    ).toEqual({
      nativeTaskId: "call-spawn-1",
      prompt: "Wait then ls.",
      title: "Demo subagent wait and ls",
      model: null,
      status: "running",
      childSessionId: "019f44a6-4820-7402-925d-bc862ee711dd",
      result: null,
      suppressNormalTool: true,
    });
  });

  it("hydrates subagent completion from get_command_or_subagent_output", () => {
    expect(
      extractXAiAcpSubagentUpdate({
        toolCallId: "call-get-1",
        title: "get_command_or_subagent_output",
        status: "completed",
        data: {
          rawInput: {
            task_ids: ["019f44a6-4820-7402-925d-bc862ee711dd"],
            timeout_ms: 30000,
          },
          rawOutput: {
            type: "Text",
            text: [
              "=== Task 019f44a6-4820-7402-925d-bc862ee711dd ===",
              "Status: completed",
              "Exit Code: 0",
              "",
              "=== Output ===",
              "SUBAGENT_MARKER: 35 entries",
            ].join("\n"),
          },
        },
      }),
    ).toEqual({
      nativeTaskId: "call-get-1",
      prompt: "",
      title: null,
      model: null,
      status: "completed",
      childSessionId: "019f44a6-4820-7402-925d-bc862ee711dd",
      result: "SUBAGENT_MARKER: 35 entries",
      suppressNormalTool: true,
    });
  });

  it("attributes multi-task get_output envelopes to the result task_id", () => {
    expect(
      extractXAiAcpSubagentUpdate({
        toolCallId: "call-get-multi",
        title: "get_command_or_subagent_output",
        status: "completed",
        data: {
          rawInput: {
            task_ids: [
              "019f44a6-4820-7402-925d-bc862ee711dd",
              "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
            ],
            timeout_ms: 30000,
          },
          rawOutput: {
            type: "TaskOutput",
            Result: {
              task_id: "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
              status: "completed",
              exit_code: 0,
              output: "SECOND_SUB_DONE\n",
            },
          },
        },
      }),
    ).toMatchObject({
      childSessionId: "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
      status: "completed",
      result: "SECOND_SUB_DONE",
    });
  });

  it("hydrates structured ACP TaskOutput tool envelopes", () => {
    expect(
      extractXAiAcpSubagentUpdate({
        toolCallId: "call-get-2",
        title: "[subagent:general-purpose] Sleep then return SUBAGENT_DONE (019f44b0)",
        status: "completed",
        data: {
          rawInput: {
            variant: "TaskOutput",
            task_ids: ["019f44b0-1b73-7f32-bb1b-1ff696f536e3"],
            timeout_ms: 20000,
          },
          rawOutput: {
            type: "TaskOutput",
            Result: {
              task_id: "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
              status: "completed",
              exit_code: 0,
              output:
                "SUBAGENT_DONE\n\n<subagent_meta>id=019f44b0-1b73-7f32-bb1b-1ff696f536e3</subagent_meta>\n",
            },
          },
        },
      }),
    ).toEqual({
      nativeTaskId: "call-get-2",
      prompt: "",
      title: null,
      model: null,
      status: "completed",
      childSessionId: "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
      result: "SUBAGENT_DONE",
      suppressNormalTool: true,
    });
  });

  it("does not leak raw machine tags when get_output is only meta/result blocks", () => {
    const metaOnlyToolCall = {
      toolCallId: "call-get-meta-only",
      title: "get_command_or_subagent_output",
      status: "completed" as const,
      data: {
        rawInput: {
          variant: "TaskOutput",
          task_ids: ["019f44b0-1b73-7f32-bb1b-1ff696f536e3"],
          timeout_ms: 20000,
        },
        rawOutput: {
          type: "TaskOutput",
          Result: {
            task_id: "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
            status: "completed",
            exit_code: 0,
            output:
              "<subagent_meta>id=019f44b0-1b73-7f32-bb1b-1ff696f536e3</subagent_meta>\n<subagent_result>done</subagent_result>\n",
          },
        },
      },
    };
    expect(extractXAiAcpSubagentUpdate(metaOnlyToolCall)).toEqual({
      nativeTaskId: "call-get-meta-only",
      prompt: "",
      title: null,
      model: null,
      status: "completed",
      childSessionId: "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
      result: null,
      suppressNormalTool: true,
    });
    expect(extractXAiBackgroundTaskCompletion(metaOnlyToolCall)).toEqual([
      {
        taskId: "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
        status: "completed",
        appendOutput: "",
      },
    ]);
  });

  it("keeps monitor start ACKs running and extracts task ids", () => {
    const toolCall = {
      toolCallId: "call-mon-1",
      title: "monitor",
      status: "completed" as const,
      data: {
        rawInput: {
          command: "echo mon_line_1",
          description: "Demo monitor",
        },
        rawOutput: {
          type: "Text",
          text: "Monitor started (task 019f44a5-87d1-7640-8e35-6a4667ffc873, timeout 36000000ms).\nYou will be notified on each event.",
        },
      },
    };
    expect(normalizeXAiAcpToolCallState(toolCall).status).toBe("inProgress");
    expect(extractXAiMonitorTaskId(toolCall)).toBe("019f44a5-87d1-7640-8e35-6a4667ffc873");
  });

  it("completes Monitor variant tools from structured Bash exit codes", () => {
    const toolCall = {
      toolCallId: "call-mon-2",
      title: "Tool",
      status: "inProgress" as const,
      data: {
        rawInput: {
          variant: "Monitor",
          command: "echo MON_DONE",
          description: "Stream mon lines",
        },
        rawOutput: {
          type: "Bash",
          output: Array.from(new TextEncoder().encode("mon_line_1\nMON_DONE\n")),
          output_for_prompt: "mon_line_1\nMON_DONE\n",
          exit_code: 0,
        },
      },
    };
    expect(isXAiMonitorTool(toolCall)).toBe(true);
    expect(normalizeXAiAcpToolCallState(toolCall).status).toBe("completed");
  });

  it("detects Monitor start ACKs from structured rawOutput when title is generic", () => {
    const toolCall = {
      toolCallId: "call-mon-generic-title",
      title: "Tool",
      status: "completed" as const,
      data: {
        rawInput: {
          command: "echo mon_line",
          description: "Demo monitor without variant",
        },
        rawOutput: {
          type: "Monitor",
          taskId: "019f44a5-87d1-7640-8e35-6a4667ffc873",
          timeoutMs: 36000000,
          persistent: false,
        },
      },
    };
    expect(isXAiMonitorTool(toolCall)).toBe(true);
    expect(normalizeXAiAcpToolCallState(toolCall).status).toBe("inProgress");
    expect(extractXAiMonitorTaskId(toolCall)).toBe("019f44a5-87d1-7640-8e35-6a4667ffc873");
  });

  it("completes wake re-reports of finished commands despite generic titles", () => {
    // Post-settle wake replay: the finished monitor is re-reported with empty
    // rawInput and a generic title, so monitor detection cannot match; the
    // structured Bash result with exit_code must still terminalize it.
    const toolCall = {
      toolCallId: "call-wake-1",
      title: "Tool",
      status: "inProgress" as const,
      data: {
        rawInput: {},
        rawOutput: {
          type: "Bash",
          output: Array.from(new TextEncoder().encode("STREAM_1\nSTREAM_DONE\n")),
          output_for_prompt: "STREAM_1\nSTREAM_DONE\n",
          exit_code: 0,
          command: "for i in 1 2; do echo STREAM_$i; done; echo STREAM_DONE",
        },
      },
    };
    expect(isXAiMonitorTool(toolCall)).toBe(false);
    const normalized = normalizeXAiAcpToolCallState(toolCall);
    expect(normalized.status).toBe("completed");
    expect(normalized.title).toBe("for i in 1 2; do echo STREAM_$i; done; echo STREAM_DONE");
    expect(
      normalizeXAiAcpToolCallState({
        ...toolCall,
        data: {
          ...toolCall.data,
          rawOutput: { ...toolCall.data.rawOutput, exit_code: 2 },
        },
      }).status,
    ).toBe("failed");
  });

  it("keeps empty successful Bash updates running until native output or turn settlement", () => {
    const normalized = normalizeXAiAcpToolCallState({
      toolCallId: "call-bash-permission-ack",
      title: "Ran command",
      status: "completed",
      data: {
        rawInput: { command: "sleep 40" },
        rawOutput: { type: "Bash", exit_code: 0 },
      },
    });
    expect(normalized.status).toBe("inProgress");
  });

  it("keeps structured Monitor start ACKs running and extracts taskId", () => {
    const toolCall = {
      toolCallId: "call-mon-3",
      title: "Start monitor: Wait 30s then list directory",
      status: "completed" as const,
      data: {
        rawInput: {
          variant: "Monitor",
          command: "sleep 30 && ls",
          description: "Wait 30s then list directory",
        },
        rawOutput: {
          type: "Monitor",
          taskId: "019f44b8-8e98-7c80-a40e-df1e26a5f9e3",
          timeoutMs: 36000000,
          persistent: false,
        },
      },
    };
    expect(normalizeXAiAcpToolCallState(toolCall).status).toBe("inProgress");
    expect(extractXAiMonitorTaskId(toolCall)).toBe("019f44b8-8e98-7c80-a40e-df1e26a5f9e3");
  });

  it("replaces generic ACP titles with description / Monitor labels", () => {
    expect(isGenericAcpToolTitle("Tool")).toBe(true);
    expect(isGenericAcpToolTitle("Read package.json")).toBe(false);
    expect(
      resolveXAiAcpToolTitle({
        toolCallId: "call-mon-title",
        title: "Tool",
        status: "completed",
        data: {
          rawInput: {
            variant: "Monitor",
            command: "sleep 30 && ls",
            description: "Wait 30s then list directory",
          },
        },
      }),
    ).toBe("Monitor: Wait 30s then list directory");
    const normalized = normalizeXAiAcpToolCallState({
      toolCallId: "call-mon-title",
      title: "Tool",
      status: "completed",
      data: {
        rawInput: {
          variant: "Monitor",
          command: "sleep 30 && ls",
          description: "Wait 30s then list directory",
        },
        rawOutput: {
          type: "Monitor",
          taskId: "019f44b8-8e98-7c80-a40e-df1e26a5f9e3",
          timeoutMs: 36000000,
          persistent: false,
        },
      },
    });
    expect(normalized.title).toBe("Monitor: Wait 30s then list directory");
    expect(normalized.status).toBe("inProgress");
    // Non-generic titles from the CLI are preserved.
    expect(
      resolveXAiAcpToolTitle({
        toolCallId: "call-read",
        title: "Read package.json",
        status: "inProgress",
        data: { rawInput: { path: "package.json" } },
      }),
    ).toBe("Read package.json");
  });

  it("hydrates monitor completion from TaskOutput get_command envelopes", () => {
    expect(
      extractXAiBackgroundTaskCompletion({
        toolCallId: "call-get-mon",
        title: "Wait 30s then list directory",
        status: "completed",
        data: {
          rawInput: {
            variant: "TaskOutput",
            task_ids: ["019f44b8-8e98-7c80-a40e-df1e26a5f9e3"],
          },
          rawOutput: {
            type: "TaskOutput",
            Result: {
              task_id: "019f44b8-8e98-7c80-a40e-df1e26a5f9e3",
              command: "[monitor] Wait 30s then list directory",
              status: "completed",
              exit_code: 0,
              output: "agents\nAGENTS.md\nnotes\n",
            },
          },
        },
      }),
    ).toEqual([
      {
        taskId: "019f44b8-8e98-7c80-a40e-df1e26a5f9e3",
        status: "completed",
        appendOutput: "agents\nAGENTS.md\nnotes",
      },
    ]);
  });

  it("hydrates monitor completion from a standalone TaskOutput frame without rawInput", () => {
    // Post-settle shape observed live (2026-07-12): the final
    // get_command_or_subagent_output update carries only rawOutput; the frame
    // is parsed in isolation (no in-turn merge), and this completion is the
    // ONLY end signal when the agent consumed the output itself (no "Monitor
    // ended" reminder follows).
    expect(
      extractXAiBackgroundTaskCompletion({
        toolCallId: "call-c29e64dd-ce5d-4eac-a6ca-c20513fefac3-1",
        title: "[monitor] Stream numbered markers every 3s (019f54a0)",
        status: "completed",
        data: {
          rawOutput: {
            type: "TaskOutput",
            Result: {
              task_id: "019f54a0-06a8-77f2-8214-e24937cad564",
              command: "[monitor] Stream numbered markers every 3s",
              status: "completed",
              exit_code: 0,
              output: "STREAM_1\nSTREAM_DONE\n",
            },
          },
        },
      }),
    ).toMatchObject([
      {
        taskId: "019f54a0-06a8-77f2-8214-e24937cad564",
        status: "completed",
      },
    ]);
  });

  it("hydrates every requested monitor when TaskOutput has no result task_id", () => {
    expect(
      extractXAiBackgroundTaskCompletion({
        toolCallId: "call-get-multi-mon",
        title: "get_command_or_subagent_output",
        status: "completed",
        data: {
          rawInput: {
            variant: "TaskOutput",
            task_ids: [
              "019f44a6-4820-7402-925d-bc862ee711dd",
              "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
            ],
          },
          rawOutput: {
            type: "TaskOutput",
            Result: {
              status: "completed",
              exit_code: 0,
              output: "BOTH_DONE\n",
            },
          },
        },
      }),
    ).toEqual([
      {
        taskId: "019f44a6-4820-7402-925d-bc862ee711dd",
        status: "completed",
        appendOutput: "BOTH_DONE",
      },
      {
        taskId: "019f44b0-1b73-7f32-bb1b-1ff696f536e3",
        status: "completed",
        appendOutput: "BOTH_DONE",
      },
    ]);
  });

  it("treats Exit Code: -1 text envelopes as failed", () => {
    expect(
      extractXAiBackgroundTaskCompletion({
        toolCallId: "call-get-neg",
        title: "get_command_or_subagent_output",
        status: "completed",
        data: {
          rawInput: {
            variant: "TaskOutput",
            task_ids: ["019f44b8-8e98-7c80-a40e-df1e26a5f9e3"],
          },
          rawOutput: {
            type: "Text",
            text: ["=== Task 019f44b8-8e98-7c80-a40e-df1e26a5f9e3 ===", "Exit Code: -1"].join("\n"),
          },
        },
      }),
    ).toMatchObject([
      {
        taskId: "019f44b8-8e98-7c80-a40e-df1e26a5f9e3",
        status: "failed",
      },
    ]);
  });

  it("tombstones tasks the model kills via kill_command_or_subagent", () => {
    expect(
      extractXAiKilledBackgroundTasks({
        toolCallId: "call-kill-1",
        title: "kill_command_or_subagent",
        status: "completed",
        data: {
          rawInput: {
            variant: "Kill",
            task_ids: ["call-bg-1", "call-bg-2", "call-bg-1"],
          },
        },
      }),
    ).toEqual([
      { taskId: "call-bg-1", status: "completed", appendOutput: "" },
      { taskId: "call-bg-2", status: "completed", appendOutput: "" },
    ]);
    // Singular task_id shape, matched by variant when the title is generic.
    expect(
      extractXAiKilledBackgroundTasks({
        toolCallId: "call-kill-2",
        title: "Tool",
        status: "failed",
        data: { rawInput: { variant: "kill", task_id: "call-bg-3" } },
      }),
    ).toEqual([{ taskId: "call-bg-3", status: "completed", appendOutput: "" }]);
    // In-flight kill calls and unrelated tools contribute nothing.
    expect(
      extractXAiKilledBackgroundTasks({
        toolCallId: "call-kill-3",
        title: "kill_command_or_subagent",
        status: "inProgress",
        data: { rawInput: { task_ids: ["call-bg-4"] } },
      }),
    ).toEqual([]);
    expect(
      extractXAiKilledBackgroundTasks({
        toolCallId: "call-get",
        title: "get_command_or_subagent_output",
        status: "completed",
        data: { rawInput: { variant: "TaskOutput", task_ids: ["call-bg-5"] } },
      }),
    ).toEqual([]);
  });

  it("maps task lifecycle notifications to background mutations", () => {
    // task_backgrounded carries the cancelled call's tool_call_id as task_id.
    expect(
      xAiBackgroundTaskLifecycleMutation(
        {
          sessionId: "session-1",
          update: {
            sessionUpdate: "task_backgrounded",
            tool_call_id: "call-bg-1",
            task_id: "call-bg-1",
          },
        },
        "running",
      ),
    ).toEqual({ sessionId: "session-1", taskId: "call-bg-1", status: "running" });
    // task_completed nests the id inside task_snapshot.
    expect(
      xAiBackgroundTaskLifecycleMutation(
        {
          sessionId: "session-1",
          update: {
            sessionUpdate: "task_completed",
            task_snapshot: { task_id: "call-bg-1" },
          },
        },
        "completed",
      ),
    ).toEqual({ sessionId: "session-1", taskId: "call-bg-1", status: "completed" });
    expect(
      xAiBackgroundTaskLifecycleMutation(
        { sessionId: "session-1", update: { sessionUpdate: "task_completed" } },
        "completed",
      ),
    ).toBeNull();
  });

  it("detects persistent Monitor start ACKs", () => {
    expect(
      isXAiPersistentMonitor({
        toolCallId: "call-mon-persist",
        title: "Monitor",
        status: "completed",
        data: {
          rawInput: { variant: "Monitor" },
          rawOutput: {
            type: "Monitor",
            taskId: "019f44b8-8e98-7c80-a40e-df1e26a5f9e3",
            timeoutMs: 36000000,
            persistent: true,
          },
        },
      }),
    ).toBe(true);
    expect(
      isXAiPersistentMonitor({
        toolCallId: "call-mon-ephemeral",
        title: "Monitor",
        status: "completed",
        data: {
          rawInput: { variant: "Monitor" },
          rawOutput: {
            type: "Monitor",
            taskId: "019f44b8-8e98-7c80-a40e-df1e26a5f9e3",
            timeoutMs: 36000000,
            persistent: false,
          },
        },
      }),
    ).toBe(false);
  });

  it("keeps a standalone TaskOutput completion terminal through normalize", () => {
    // Must remain offer evidence post-settle: normalize must not demote it to
    // inProgress the way monitor start ACKs are.
    expect(
      normalizeXAiAcpToolCallState({
        toolCallId: "call-c29e64dd-ce5d-4eac-a6ca-c20513fefac3-1",
        title: "[monitor] Stream numbered markers every 3s (019f54a0)",
        status: "completed",
        data: {
          rawOutput: {
            type: "TaskOutput",
            Result: {
              task_id: "019f54a0-06a8-77f2-8214-e24937cad564",
              status: "completed",
              exit_code: 0,
              output: "STREAM_DONE\n",
            },
          },
        },
      }).status,
    ).toBe("completed");
  });

  it("parses monitor event lines and end reminders", () => {
    expect(
      extractXAiAcpBackgroundToolMutation(
        '<monitor-event task_id="019f44a5-87d1-7640-8e35-6a4667ffc873">\n[Demo] mon_line_1\n</monitor-event>',
      ),
    ).toEqual([
      {
        taskId: "019f44a5-87d1-7640-8e35-6a4667ffc873",
        status: "running",
        appendOutput: "[Demo] mon_line_1\n",
      },
    ]);
    expect(
      extractXAiAcpBackgroundToolMutation(
        [
          "<system-reminder>",
          'Monitor "019f44a5-87d1-7640-8e35-6a4667ffc873" ended: [monitor ended: exited (code 0)].',
          "Description: Demo monitor",
          "</system-reminder>",
        ].join("\n"),
      ),
    ).toMatchObject([
      {
        taskId: "019f44a5-87d1-7640-8e35-6a4667ffc873",
        status: "completed",
      },
    ]);
    // Description/output may contain "error" without meaning the monitor failed.
    expect(
      extractXAiAcpBackgroundToolMutation(
        [
          "<system-reminder>",
          'Monitor "019f44a5-87d1-7640-8e35-6a4667ffc873" ended: [monitor ended: exited (code 0)].',
          "Description: watch error logs for failed deploys",
          "error: nothing found",
          "</system-reminder>",
        ].join("\n"),
      ),
    ).toMatchObject([
      {
        taskId: "019f44a5-87d1-7640-8e35-6a4667ffc873",
        status: "completed",
      },
    ]);
  });

  it("parses every monitor-event and trailing end notice in one chunk", () => {
    const mutations = extractXAiAcpBackgroundToolMutation(
      [
        '<monitor-event task_id="019f44a5-87d1-7640-8e35-6a4667ffc873">',
        "[Demo] mon_line_1",
        "</monitor-event>",
        '<monitor-event task_id="019f44a5-87d1-7640-8e35-6a4667ffc873">',
        "[Demo] mon_line_2",
        "</monitor-event>",
        'Monitor "019f44a5-87d1-7640-8e35-6a4667ffc873" ended: [monitor ended: exited (code 0)].',
      ].join("\n"),
    );
    expect(mutations).toHaveLength(3);
    expect(mutations[0]).toEqual({
      taskId: "019f44a5-87d1-7640-8e35-6a4667ffc873",
      status: "running",
      appendOutput: "[Demo] mon_line_1\n",
    });
    expect(mutations[1]).toEqual({
      taskId: "019f44a5-87d1-7640-8e35-6a4667ffc873",
      status: "running",
      appendOutput: "[Demo] mon_line_2\n",
    });
    expect(mutations[2]).toMatchObject({
      taskId: "019f44a5-87d1-7640-8e35-6a4667ffc873",
      status: "completed",
    });
  });

  it("parses batched monitor event blocks as running mutations", () => {
    expect(
      extractXAiAcpBackgroundToolMutation(
        [
          "3 monitor events from 1 monitor (use get_command_or_subagent_output to identify each monitor):",
          "",
          '<monitor description="Stream STREAM_i every 3s" task_id="019f545d-4d39-7001-b1c8-c7744c448ec1">',
          "[1] STREAM_7",
          "[2] STREAM_8",
          "[3] STREAM_9",
          "</monitor>",
        ].join("\n"),
      ),
    ).toEqual([
      {
        taskId: "019f545d-4d39-7001-b1c8-c7744c448ec1",
        status: "running",
        appendOutput: "[1] STREAM_7\n[2] STREAM_8\n[3] STREAM_9\n",
      },
    ]);
  });

  it("parses the subagent completed reminder as an end notice", () => {
    expect(
      extractXAiAcpSubagentEndNotice(
        [
          "<system-reminder>",
          'Background subagent "019f5470-bf92-7a90-afb3-5a6cea5b34a3" (general-purpose: "Run sleep then echo token") completed successfully.',
          "Duration: 28.8s | Tool calls: 1 | Turns: 1",
          'Use get_task_output("019f5470-bf92-7a90-afb3-5a6cea5b34a3") to see the full output.',
          "</system-reminder>",
        ].join("\n"),
      ),
    ).toEqual({
      childSessionId: "019f5470-bf92-7a90-afb3-5a6cea5b34a3",
      status: "completed",
    });
  });

  it("parses a failed subagent reminder as a failed end notice", () => {
    expect(
      extractXAiAcpSubagentEndNotice(
        'Background subagent "019f5470-bf92-7a90-afb3-5a6cea5b34a3" (general-purpose: "Run sleep then echo token") failed.',
      ),
    ).toEqual({
      childSessionId: "019f5470-bf92-7a90-afb3-5a6cea5b34a3",
      status: "failed",
    });
  });

  it("ignores prompt text that merely mentions subagents", () => {
    expect(
      extractXAiAcpSubagentEndNotice("Live-test post-settle subagent completion."),
    ).toBeUndefined();
    expect(
      extractXAiAcpSubagentEndNotice(
        'Background subagent "019f5470-bf92-7a90-afb3-5a6cea5b34a3" (general-purpose: "Run sleep then echo token") is still running.',
      ),
    ).toBeUndefined();
  });

  it("does not treat nested parentheses in the title as the outcome verb", () => {
    expect(
      extractXAiAcpSubagentEndNotice(
        'Background subagent "019f5470-bf92-7a90-afb3-5a6cea5b34a3" (general-purpose: "Check (backend) failed tests") is still running.',
      ),
    ).toBeUndefined();
    expect(
      extractXAiAcpSubagentEndNotice(
        'Background subagent "019f5470-bf92-7a90-afb3-5a6cea5b34a3" (general-purpose: "Check (backend) failed tests") completed successfully.',
      ),
    ).toEqual({
      childSessionId: "019f5470-bf92-7a90-afb3-5a6cea5b34a3",
      status: "completed",
    });
  });

  it("extracts questions from the real xAI ask_user_question payload shape", () => {
    const questions = extractXAiAskUserQuestions({
      sessionId: "session-1",
      toolCallId: "tool-call-1",
      mode: "default",
      questions: [
        {
          id: "scope",
          question: "Which scope should Grok use?",
          options: [
            { label: "Workspace", description: "Use the current workspace" },
            { label: "Session", description: "Only use this session" },
          ],
        },
      ],
    });

    expect(questions).toEqual([
      {
        id: "scope",
        header: "Question",
        question: "Which scope should Grok use?",
        multiSelect: false,
        options: [
          { label: "Workspace", description: "Use the current workspace" },
          { label: "Session", description: "Only use this session" },
        ],
      },
    ]);
  });

  it("extracts questions from wrapped _x.ai extension payloads", () => {
    const payload = {
      method: "_x.ai/ask_user_question",
      params: {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        mode: "plan",
        questions: [
          {
            question: "Which changes should be included?",
            multiSelect: true,
            options: [{ label: "Tests" }, { label: "Docs" }],
          },
        ],
      },
    };
    const decoded = decodeXAiAskUserQuestionRequest(payload);
    const questions = extractXAiAskUserQuestions(decoded);

    expect(questions).toEqual([
      {
        id: "Which changes should be included?",
        header: "Question",
        question: "Which changes should be included?",
        multiSelect: true,
        options: [
          { label: "Tests", description: "Tests" },
          { label: "Docs", description: "Docs" },
        ],
      },
    ]);
  });

  it("treats nullable multiSelect from Grok as single-select", () => {
    const questions = extractXAiAskUserQuestions({
      sessionId: "session-1",
      toolCallId: "tool-call-1",
      mode: "default",
      questions: [
        {
          question: "Which label should Grok use?",
          multiSelect: null,
          options: [
            { label: "Alpha", description: "Use the Alpha label" },
            { label: "Beta", description: "Use the Beta label" },
            { label: "Other", description: "Use the Other label" },
          ],
        },
      ],
    });

    expect(questions).toEqual([
      {
        id: "Which label should Grok use?",
        header: "Question",
        question: "Which label should Grok use?",
        multiSelect: false,
        options: [
          { label: "Alpha", description: "Use the Alpha label" },
          { label: "Beta", description: "Use the Beta label" },
          { label: "Other", description: "Use the Other label" },
        ],
      },
    ]);
  });

  it("maps UI question ids back to xAI question text in accepted responses", () => {
    const response = makeXAiAskUserQuestionResponse(
      {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        mode: "default",
        questions: [
          {
            id: "scope",
            question: "Which scope should Grok use?",
            options: [
              { label: "workspace", description: "Use the current workspace" },
              { label: "session", description: "Only use this session" },
            ],
          },
        ],
      },
      { scope: "workspace" },
    );

    expect(response).toEqual({
      outcome: "accepted",
      answers: {
        "Which scope should Grok use?": ["workspace"],
      },
    });
  });

  it("orders accepted answers by the original xAI question order", () => {
    const response = makeXAiAskUserQuestionResponse(
      {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        mode: "default",
        questions: [
          {
            id: "first",
            question: "First question?",
            options: [{ label: "A", description: "A" }],
          },
          {
            id: "second",
            question: "Second question?",
            options: [{ label: "B", description: "B" }],
          },
        ],
      },
      {
        second: "B",
        first: "A",
      },
    );

    expect(Object.keys(response.answers)).toEqual(["First question?", "Second question?"]);
    expect(response).toMatchObject({
      outcome: "accepted",
      answers: {
        "First question?": ["A"],
        "Second question?": ["B"],
      },
    });
  });

  it("encodes typed custom answers as xAI Other annotations", () => {
    const response = makeXAiAskUserQuestionResponse(
      {
        method: "x.ai/ask_user_question",
        params: {
          sessionId: "session-1",
          toolCallId: "tool-call-1",
          mode: "default",
          questions: [
            {
              question: "Which ice cream flavor?",
              options: [
                { label: "vanilla", description: "Vanilla flavor" },
                { label: "chocolate", description: "Chocolate flavor" },
              ],
            },
          ],
        },
      },
      { "Which ice cream flavor?": "pistachio" },
    );

    expect(response).toEqual({
      outcome: "accepted",
      answers: {
        "Which ice cream flavor?": ["Other"],
      },
      annotations: {
        "Which ice cream flavor?": {
          notes: "pistachio",
        },
      },
    });
  });

  it("encodes interrupted dialogs as xAI cancelled responses", () => {
    expect(makeXAiAskUserQuestionCancelledResponse()).toEqual({
      outcome: "cancelled",
    });
  });

  it("does not echo preview annotations for multi-select answers", () => {
    const response = makeXAiAskUserQuestionResponse(
      {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        mode: "default",
        questions: [
          {
            question: "Which files should Grok touch?",
            multiSelect: true,
            options: [
              {
                label: "Tests",
                description: "Update tests",
                preview: "test preview",
              },
              {
                label: "Docs",
                description: "Update docs",
                preview: "docs preview",
              },
            ],
          },
        ],
      },
      { "Which files should Grok touch?": ["Tests", "Docs"] },
    );

    expect(response).toEqual({
      outcome: "accepted",
      answers: {
        "Which files should Grok touch?": ["Tests", "Docs"],
      },
    });
  });

  it.effect("settles a hung prompt from a root-session prompt_complete notification", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, (notification: unknown) => Effect.Effect<void>>();
      const hungPrompt = yield* Deferred.make<never>();
      const baseRuntime = {
        start: () =>
          Effect.succeed({
            sessionId: "root-session",
            initializeResult: {},
            sessionSetupResult: {},
            modelConfigId: undefined,
          }),
        prompt: () => Deferred.await(hungPrompt),
        cancel: Effect.void,
        handleExtNotification: (
          method: string,
          _schema: unknown,
          handler: (notification: unknown) => Effect.Effect<void>,
        ) => {
          handlers.set(method, handler);
          return Effect.void;
        },
        handleExtRequest: () => Effect.void,
      } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

      const runtime = yield* makeXAiPromptCompletionRuntime(baseRuntime);
      const promptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "hi" }] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const promptCompleteHandler = handlers.get("_x.ai/session/prompt_complete");
      expect(promptCompleteHandler).toBeDefined();
      yield* promptCompleteHandler!({
        sessionId: "root-session",
        stopReason: "end_turn",
      });
      const response = yield* Fiber.join(promptFiber);
      expect(response.stopReason).toBe("end_turn");
    }),
  );

  it.effect("settles a hung prompt from _x.ai/session/update turn_completed", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, (notification: unknown) => Effect.Effect<void>>();
      let capturedMeta: Record<string, unknown> | null | undefined;
      const hungPrompt = yield* Deferred.make<never>();
      const baseRuntime = {
        start: () =>
          Effect.succeed({
            sessionId: "root-session",
            initializeResult: {},
            sessionSetupResult: {},
            modelConfigId: undefined,
          }),
        prompt: (payload: { readonly _meta?: Record<string, unknown> | null }) => {
          capturedMeta = payload._meta ?? null;
          return Deferred.await(hungPrompt);
        },
        cancel: Effect.void,
        handleExtNotification: (
          method: string,
          _schema: unknown,
          handler: (notification: unknown) => Effect.Effect<void>,
        ) => {
          handlers.set(method, handler);
          return Effect.void;
        },
        handleExtRequest: () => Effect.void,
      } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

      const runtime = yield* makeXAiPromptCompletionRuntime(baseRuntime);
      const promptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "hi" }] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const promptId = capturedMeta?.promptId;
      expect(typeof promptId).toBe("string");
      const sessionUpdateHandler = handlers.get("_x.ai/session/update");
      expect(sessionUpdateHandler).toBeDefined();
      yield* sessionUpdateHandler!({
        sessionId: "root-session",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: promptId,
          stop_reason: "end_turn",
        },
      });
      const response = yield* Fiber.join(promptFiber);
      expect(response.stopReason).toBe("end_turn");
    }),
  );

  it.effect("ignores turn_completed for non-pending prompt ids and task completions", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, (notification: unknown) => Effect.Effect<void>>();
      const hungPrompt = yield* Deferred.make<never>();
      const baseRuntime = {
        start: () =>
          Effect.succeed({
            sessionId: "root-session",
            initializeResult: {},
            sessionSetupResult: {},
            modelConfigId: undefined,
          }),
        prompt: () => Deferred.await(hungPrompt),
        cancel: Effect.void,
        handleExtNotification: (
          method: string,
          _schema: unknown,
          handler: (notification: unknown) => Effect.Effect<void>,
        ) => {
          handlers.set(method, handler);
          return Effect.void;
        },
        handleExtRequest: () => Effect.void,
      } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

      const runtime = yield* makeXAiPromptCompletionRuntime(baseRuntime);
      const promptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "hi" }] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const sessionUpdateHandler = handlers.get("_x.ai/session/update");
      expect(sessionUpdateHandler).toBeDefined();
      yield* sessionUpdateHandler!({
        sessionId: "root-session",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "task-completed-call-abc",
          stop_reason: "end_turn",
        },
      });
      yield* sessionUpdateHandler!({
        sessionId: "root-session",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "some-other-cli-turn",
          stop_reason: "end_turn",
        },
      });
      yield* Effect.yieldNow;
      expect(promptFiber.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(promptFiber);
    }),
  );

  it.effect("ignores prompt_complete notifications for foreign session ids", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, (notification: unknown) => Effect.Effect<void>>();
      const hungPrompt = yield* Deferred.make<never>();
      const baseRuntime = {
        start: () =>
          Effect.succeed({
            sessionId: "root-session",
            initializeResult: {},
            sessionSetupResult: {},
            modelConfigId: undefined,
          }),
        prompt: () => Deferred.await(hungPrompt),
        cancel: Effect.void,
        handleExtNotification: (
          method: string,
          _schema: unknown,
          handler: (notification: unknown) => Effect.Effect<void>,
        ) => {
          handlers.set(method, handler);
          return Effect.void;
        },
        handleExtRequest: () => Effect.void,
      } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

      const runtime = yield* makeXAiPromptCompletionRuntime(baseRuntime);
      const promptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "hi" }] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const promptCompleteHandler = handlers.get("_x.ai/session/prompt_complete");
      expect(promptCompleteHandler).toBeDefined();
      yield* promptCompleteHandler!({
        sessionId: "child-session",
      });
      yield* Effect.yieldNow;
      expect(promptFiber.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(promptFiber);
    }),
  );

  it.effect(
    "ignores promptId-less prompt_complete when multiple prompts are pending on the same session",
    () =>
      Effect.gen(function* () {
        const handlers = new Map<string, (notification: unknown) => Effect.Effect<void>>();
        const hungPrompt = yield* Deferred.make<never>();
        const baseRuntime = {
          start: () =>
            Effect.succeed({
              sessionId: "root-session",
              initializeResult: {},
              sessionSetupResult: {},
              modelConfigId: undefined,
            }),
          prompt: () => Deferred.await(hungPrompt),
          cancel: Effect.void,
          handleExtNotification: (
            method: string,
            _schema: unknown,
            handler: (notification: unknown) => Effect.Effect<void>,
          ) => {
            handlers.set(method, handler);
            return Effect.void;
          },
          handleExtRequest: () => Effect.void,
        } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

        const runtime = yield* makeXAiPromptCompletionRuntime(baseRuntime);
        const firstPromptFiber = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "first" }] })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const secondPromptFiber = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "second" }] })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const promptCompleteHandler = handlers.get("_x.ai/session/prompt_complete");
        expect(promptCompleteHandler).toBeDefined();
        yield* promptCompleteHandler!({
          sessionId: "root-session",
          stopReason: "end_turn",
        });
        yield* Effect.yieldNow;
        expect(firstPromptFiber.pollUnsafe()).toBeUndefined();
        expect(secondPromptFiber.pollUnsafe()).toBeUndefined();
        yield* Fiber.interrupt(firstPromptFiber);
        yield* Fiber.interrupt(secondPromptFiber);
      }),
  );

  it.effect("injects promptId and requestId into prompt _meta", () =>
    Effect.gen(function* () {
      let capturedMeta: Record<string, unknown> | null | undefined;
      const baseRuntime = {
        start: () => Effect.succeed({ sessionId: "session-1" }),
        prompt: (payload: { readonly _meta?: Record<string, unknown> | null }) => {
          capturedMeta = payload._meta ?? null;
          return Effect.succeed({ stopReason: "end_turn" as const });
        },
        cancel: Effect.void,
        handleExtNotification: () => Effect.void,
        handleExtRequest: () => Effect.void,
      } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

      const runtime = yield* makeXAiPromptCompletionRuntime(baseRuntime);
      yield* runtime.prompt({ prompt: [{ type: "text", text: "hi" }] });

      expect(typeof capturedMeta?.promptId).toBe("string");
      expect(capturedMeta).toMatchObject({
        promptId: capturedMeta?.promptId,
        requestId: capturedMeta?.promptId,
      });
    }),
  );
});
