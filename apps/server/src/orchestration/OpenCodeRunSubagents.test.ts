import type { ToolCallContent } from "effect-acp/schema";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveOpenCodeRunEvents,
  openCodeRunItemKey,
  parseOpenCodeRunCommand,
  parseOpenCodeRunOutput,
} from "./OpenCodeRunSubagents.ts";

const base = {
  provider: ProviderDriverKind.make("claude"),
  createdAt: "2026-09-11T10:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  itemId: RuntimeItemId.make("tool-1"),
};

const jsonLine = (value: unknown) => JSON.stringify(value);

const runJsonOutput = [
  jsonLine({
    type: "step_start",
    timestamp: 1_000,
    sessionID: "ses_parent",
    part: { type: "step-start" },
  }),
  jsonLine({
    type: "tool_use",
    timestamp: 1_500,
    sessionID: "ses_parent",
    part: {
      id: "prt_1",
      callID: "call_1",
      tool: "task",
      state: {
        status: "completed",
        title: "Multiply numbers",
        input: {
          description: "Multiply numbers",
          prompt: "What is 17 * 23?",
          subagent_type: "flash",
        },
        output:
          '<task id="ses_child_1" state="completed">\n<task_result>\n391\n</task_result>\n</task>',
        metadata: {
          parentSessionId: "ses_parent",
          sessionId: "ses_child_1",
          model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" },
        },
        time: { start: 1_100, end: 1_400 },
      },
    },
  }),
  jsonLine({
    type: "tool_use",
    timestamp: 1_600,
    sessionID: "ses_parent",
    part: {
      id: "prt_2",
      callID: "call_2",
      tool: "task",
      state: {
        status: "error",
        input: { description: "Sort words", subagent_type: "flash" },
        error: "Task failed",
        metadata: { sessionId: "ses_child_2", model: { modelID: "deepseek-v4.1-flash" } },
      },
    },
  }),
  jsonLine({
    type: "tool_use",
    timestamp: 1_700,
    sessionID: "ses_parent",
    part: { id: "prt_3", callID: "call_3", tool: "read", state: { status: "completed" } },
  }),
  jsonLine({
    type: "step_finish",
    timestamp: 1_800,
    sessionID: "ses_parent",
    part: {
      type: "step-finish",
      tokens: { total: 120, input: 100, output: 15, reasoning: 5, cache: { write: 0, read: 30 } },
    },
  }),
  jsonLine({
    type: "text",
    timestamp: 1_900,
    sessionID: "ses_parent",
    part: { type: "text", text: "Both tasks finished: 391 and a failure." },
  }),
  jsonLine({
    type: "step_finish",
    timestamp: 2_000,
    sessionID: "ses_parent",
    part: {
      type: "step-finish",
      tokens: { total: 40, input: 30, output: 10, reasoning: 0, cache: { write: 0, read: 0 } },
    },
  }),
  "not json",
].join("\n");

describe("parseOpenCodeRunCommand", () => {
  it("recognizes quoted executable and option words", () => {
    expect(
      parseOpenCodeRunCommand('"opencode" "--log-level" DEBUG "run" "--format" json "prompt"'),
    ).toMatchObject({ prompt: "prompt", jsonOutput: true });
    expect(parseOpenCodeRunCommand('opencode run -- "--format" json')).toMatchObject({
      prompt: "--format json",
      jsonOutput: false,
    });
  });

  it("recognizes assignments with quoted values but not quoted assignment words", () => {
    expect(
      parseOpenCodeRunCommand('OPENCODE_CONFIG="/tmp/config with spaces" opencode run test')
        ?.prompt,
    ).toBe("test");
    expect(parseOpenCodeRunCommand('"OPENCODE_CONFIG=value" opencode run test')).toBeUndefined();
  });

  it("recognizes combined output redirects without treating them as background runs", () => {
    for (const redirect of ["&>run.log", "&>>run.log", '&> "run log"']) {
      expect(parseOpenCodeRunCommand(`opencode run test ${redirect}`)?.prompt).toBe("test");
    }
  });

  it("only parses wrapper scripts when the shell is executed", () => {
    expect(parseOpenCodeRunCommand('echo zsh -c "opencode run do work"')).toBeUndefined();
    expect(parseOpenCodeRunCommand('"zsh" "-c" "opencode run do work"')?.prompt).toBe("do work");
  });

  it.each(["EOF", "'EOF'", '"EOF"', "E'OF'", "\\EOF"])(
    "ignores heredoc body commands with delimiter %s and resumes after the body",
    (delimiter) => {
      const script = `cat <<${delimiter}\nopencode run --format json 'example only'\nEOF`;
      expect(parseOpenCodeRunCommand(script)).toBeUndefined();
      expect(parseOpenCodeRunCommand(`${script}\nopencode run real`)?.prompt).toBe("real");
    },
  );

  it("skips tab-stripped and multiple heredoc bodies", () => {
    expect(parseOpenCodeRunCommand("cat <<-EOF\n\topencode run fake\n\tEOF")).toBeUndefined();
    expect(
      parseOpenCodeRunCommand("cat <<ONE <<'TWO'\nfirst\nONE\nopencode run fake\nTWO"),
    ).toBeUndefined();
    expect(parseOpenCodeRunCommand("cat <<EOF\nopencode run incomplete")).toBeUndefined();
    expect(parseOpenCodeRunCommand("opencode run real <<'EOF'\nexample\nEOF")?.prompt).toBe("real");
  });

  it("ignores background shell wrappers but finds subsequent foreground wrappers", () => {
    expect(parseOpenCodeRunCommand("sh -c 'opencode run test' &")).toBeUndefined();
    expect(parseOpenCodeRunCommand("sh -c 'opencode run test' >out 2>&1 &")).toBeUndefined();
    expect(parseOpenCodeRunCommand("sh -c 'opencode run test' | cat &")).toBeUndefined();
    expect(
      parseOpenCodeRunCommand("sh -c 'opencode run first' & sh -c 'opencode run second'")?.prompt,
    ).toBe("second");
  });

  it("ignores shell syntax in comments while retaining literal hashes", () => {
    expect(parseOpenCodeRunCommand("# Example input uses <<EOF\nopencode run real")?.prompt).toBe(
      "real",
    );
    expect(parseOpenCodeRunCommand("sh -c 'opencode run real' # retry & if needed")?.prompt).toBe(
      "real",
    );
    expect(parseOpenCodeRunCommand("# opencode run fake")).toBeUndefined();
    expect(parseOpenCodeRunCommand("opencode run real # <<EOF &")?.prompt).toBe("real");
    expect(parseOpenCodeRunCommand("opencode run '# quoted' \\#escaped word#suffix")?.prompt).toBe(
      "# quoted #escaped word#suffix",
    );
  });

  it("separates attached redirects from arguments without changing quoted or escaped text", () => {
    for (const redirect of [">run.log", ">>run.log", "<input.txt", " 2>run.log", " 2>&1", "<&0"]) {
      expect(parseOpenCodeRunCommand(`opencode run 'review this'${redirect}`)?.prompt).toBe(
        "review this",
      );
      expect(parseOpenCodeRunCommand(`opencode run --format json${redirect}`)?.jsonOutput).toBe(
        true,
      );
    }
    expect(parseOpenCodeRunCommand("opencode run 'a>b' a\\>b")?.prompt).toBe("a>b a>b");
    expect(parseOpenCodeRunCommand("opencode run '2'>run.log")?.prompt).toBe("2");
    expect(parseOpenCodeRunCommand("opencode run \\>literal \\2>run.log")?.prompt).toBe(
      ">literal 2",
    );
    expect(parseOpenCodeRunCommand("opencode run real 2>&1 &")).toBeUndefined();
  });

  it("ignores asynchronously executed direct command lists", () => {
    expect(parseOpenCodeRunCommand("opencode run test | cat &")).toBeUndefined();
    expect(parseOpenCodeRunCommand("opencode run test && echo done &")).toBeUndefined();
    expect(parseOpenCodeRunCommand("opencode run test || echo failed &")).toBeUndefined();
    expect(parseOpenCodeRunCommand("opencode run real; echo other &")?.prompt).toBe("real");
    expect(parseOpenCodeRunCommand("opencode run real\necho other &")?.prompt).toBe("real");
    expect(parseOpenCodeRunCommand("opencode run ignored | cat & opencode run real")?.prompt).toBe(
      "real",
    );
  });

  it("recognizes foreground combined-output pipes without accepting background lists", () => {
    expect(
      parseOpenCodeRunCommand("opencode run --format json 'review' |& tee run.log")?.jsonOutput,
    ).toBe(true);
    expect(parseOpenCodeRunCommand("sh -c 'opencode run real' |& tee run.log")?.prompt).toBe(
      "real",
    );
    expect(parseOpenCodeRunCommand("opencode run real |& tee run.log &")).toBeUndefined();
    expect(parseOpenCodeRunCommand("sh -c 'opencode run real' |& tee run.log &")).toBeUndefined();
  });

  it.each(["--model", "--title"])(
    "does not consume shell separators as values for %s",
    (option) => {
      for (const separator of [";", "|", "||", "&&", "\n"]) {
        expect(
          parseOpenCodeRunCommand(`opencode run ${option}${separator} echo next`)?.prompt,
        ).toBeUndefined();
      }
      expect(parseOpenCodeRunCommand(`opencode run ${option} ';' real`)?.prompt).toBe("real");
    },
  );

  it("keeps global option parsing inside its command and skips redirects between values", () => {
    expect(parseOpenCodeRunCommand("opencode --log-level; run fake")).toBeUndefined();
    expect(parseOpenCodeRunCommand("opencode run --model >out zen/model prompt")).toMatchObject({
      model: "zen/model",
      prompt: "prompt",
    });
    expect(
      parseOpenCodeRunCommand("sh -c 'opencode run --model; echo next'")?.prompt,
    ).toBeUndefined();
  });

  it("reads the prompt, model, agent, and output format", () => {
    expect(
      parseOpenCodeRunCommand(
        `cd /tmp && OPENCODE_CONFIG=x opencode run --format json -m opencode-go/deepseek-v4.1-flash --agent orchestrator "Multiply   17 by 23" 2>&1 | head -50`,
      ),
    ).toEqual({
      prompt: "Multiply 17 by 23",
      model: "opencode-go/deepseek-v4.1-flash",
      agent: "orchestrator",
      jsonOutput: true,
    });
  });

  it("handles equals-style options, quoted prompts, and absolute binaries", () => {
    expect(
      parseOpenCodeRunCommand(
        "/Users/me/.opencode/bin/opencode run --model=zen/big 'say \"hi\"' there --auto",
      ),
    ).toEqual({ prompt: 'say "hi" there', model: "zen/big", agent: undefined, jsonOutput: false });
  });

  it("looks inside a shell wrapper", () => {
    expect(
      parseOpenCodeRunCommand(`/bin/zsh -lc "opencode run --format json 'Review the diff'"`),
    ).toEqual({ prompt: "Review the diff", model: undefined, agent: undefined, jsonOutput: true });
  });

  it("skips global options placed before the subcommand", () => {
    expect(
      parseOpenCodeRunCommand("opencode --print-logs --log-level DEBUG run 'Say hi'")?.prompt,
    ).toBe("Say hi");
    expect(parseOpenCodeRunCommand("opencode --log-level=DEBUG run 'Say hi'")?.prompt).toBe(
      "Say hi",
    );
  });

  it("recognizes a quoted run subcommand", () => {
    expect(parseOpenCodeRunCommand('opencode "run" "Say hi"')?.prompt).toBe("Say hi");
    expect(parseOpenCodeRunCommand("opencode 'run' 'Say hi'")?.prompt).toBe("Say hi");
  });

  it("finds a foreground run after an ignored background run", () => {
    expect(
      parseOpenCodeRunCommand("opencode run 'first' & opencode run --format json 'second'"),
    ).toEqual({ prompt: "second", model: undefined, agent: undefined, jsonOutput: true });
  });

  it("ignores runs the shell backgrounds with a trailing ampersand", () => {
    expect(parseOpenCodeRunCommand("opencode run 'Say hi' &")).toBeUndefined();
    expect(parseOpenCodeRunCommand("nohup opencode run 'Say hi' > run.log 2>&1 &")).toBeUndefined();
    expect(parseOpenCodeRunCommand("opencode run 'Say hi' && echo done")?.prompt).toBe("Say hi");
  });

  it("drops prompts built from command substitution", () => {
    expect(parseOpenCodeRunCommand('opencode run "$(cat prompt.md)"')?.prompt).toBeUndefined();
  });

  it("ignores other opencode subcommands and unrelated commands", () => {
    expect(parseOpenCodeRunCommand("opencode serve --port 4096")).toBeUndefined();
    expect(parseOpenCodeRunCommand("echo 'opencode run is nice'")).toBeUndefined();
    expect(parseOpenCodeRunCommand("bun run lint")).toBeUndefined();
  });

  it("only matches when opencode is the command being run", () => {
    expect(parseOpenCodeRunCommand("echo opencode run test")).toBeUndefined();
    expect(parseOpenCodeRunCommand("grep -rn opencode run .")).toBeUndefined();
    expect(parseOpenCodeRunCommand("timeout 60 opencode run 'Say hi'")?.prompt).toBe("Say hi");
    expect(parseOpenCodeRunCommand("env FOO=1 nohup opencode run 'Say hi'")?.prompt).toBe("Say hi");
    expect(parseOpenCodeRunCommand("ls;opencode run 'Say hi'|head 2>&1")?.prompt).toBe("Say hi");
    expect(parseOpenCodeRunCommand('cd /repo\nopencode run "Say hi"\necho done')?.prompt).toBe(
      "Say hi",
    );
    expect(parseOpenCodeRunCommand('opencode run \\\n  --format json \\\n  "Say hi"')).toEqual({
      prompt: "Say hi",
      model: undefined,
      agent: undefined,
      jsonOutput: true,
    });
  });
});

describe("parseOpenCodeRunOutput", () => {
  it("unwraps the native task_id result envelope", () => {
    const output = jsonLine({
      type: "tool_use",
      part: {
        tool: "task",
        state: {
          status: "completed",
          output:
            "task_id: ses_child (for resuming to continue this task if needed)\n\n<task_result>\n391\n</task_result>",
        },
      },
    });
    expect(parseOpenCodeRunOutput(output).children[0]?.summary).toBe("391");
  });

  it("folds children, usage, and the final text out of the JSON event stream", () => {
    expect(parseOpenCodeRunOutput(runJsonOutput)).toEqual({
      children: [
        {
          id: "ses_child_1",
          title: "Multiply numbers",
          role: "flash",
          model: "opencode-go/deepseek-v4.1-flash",
          failed: false,
          summary: "391",
        },
        {
          id: "ses_child_2",
          title: "Sort words",
          role: "flash",
          model: "deepseek-v4.1-flash",
          failed: true,
          summary: "Task failed",
        },
      ],
      summary: "Both tasks finished: 391 and a failure.",
      usage: {
        totalTokens: 160,
        inputTokens: 130,
        cachedInputTokens: 30,
        outputTokens: 25,
        reasoningOutputTokens: 5,
        toolUses: 3,
        durationMs: 1_000,
      },
      failed: false,
    });
  });

  it("flags a run whose stream carried an error event", () => {
    const output = parseOpenCodeRunOutput(
      jsonLine({ type: "error", timestamp: 1, sessionID: "ses", error: { name: "Boom" } }),
    );
    expect(output.failed).toBe(true);
    expect(output.usage).toBeUndefined();
  });
});

describe("deriveOpenCodeRunEvents", () => {
  const claudeItem = (
    type: "item.started" | "item.updated" | "item.completed",
    input: Record<string, unknown>,
    extra: { status?: "completed" | "failed"; result?: unknown } = {},
  ) =>
    ({
      ...base,
      type,
      eventId: EventId.make(`evt-${type}`),
      payload: {
        itemType: "command_execution",
        status: extra.status ?? "inProgress",
        title: "Command run",
        data: {
          toolName: "Bash",
          input,
          ...(extra.result !== undefined ? { result: extra.result } : {}),
        },
      },
    }) satisfies ProviderRuntimeEvent;

  const command = 'opencode run --format json -m opencode-go/deepseek-v4.1-flash "Run both tasks"';

  it("keys only shell items", () => {
    expect(openCodeRunItemKey(claudeItem("item.started", {}))).toBe("thread-1:tool-1");
    expect(
      openCodeRunItemKey({
        ...base,
        type: "item.completed",
        eventId: EventId.make("evt-read"),
        payload: { itemType: "file_change" },
      }),
    ).toBeUndefined();
  });

  it("stays quiet until the streamed command is readable", () => {
    expect(deriveOpenCodeRunEvents(claudeItem("item.started", {}), { started: false })).toEqual([]);
    expect(
      deriveOpenCodeRunEvents(claudeItem("item.updated", { command: "bun run lint" }), {
        started: false,
      }),
    ).toEqual([]);
  });

  it("starts the delegated run once from the first readable command", () => {
    const events = deriveOpenCodeRunEvents(claudeItem("item.updated", { command }), {
      started: false,
    });
    expect(events).toEqual([
      {
        provider: base.provider,
        threadId: base.threadId,
        turnId: base.turnId,
        createdAt: base.createdAt,
        eventId: 'opencode-run:["thread-1","turn-1","tool-1"]:00000001',
        type: "task.started",
        payload: {
          taskId: "opencode-run:tool-1",
          description: "Run both tasks",
          taskType: "subagent",
          title: "Run both tasks",
          role: "opencode",
          model: "opencode-go/deepseek-v4.1-flash",
          toolUseId: "tool-1",
        },
      },
    ]);
    expect(
      deriveOpenCodeRunEvents(claudeItem("item.updated", { command }), { started: true }),
    ).toEqual([]);
  });

  it("skips background shells whose output arrives elsewhere", () => {
    expect(
      deriveOpenCodeRunEvents(claudeItem("item.updated", { command, run_in_background: true }), {
        started: false,
      }),
    ).toEqual([]);
  });

  it("settles the run and its children from the captured JSON output", () => {
    const events = deriveOpenCodeRunEvents(
      claudeItem(
        "item.completed",
        { command },
        {
          status: "completed",
          result: { type: "tool_result", tool_use_id: "tool-1", content: runJsonOutput },
        },
      ),
      { started: true },
    );
    expect(events.map((event) => [event.type, event.eventId])).toEqual([
      ["task.started", 'opencode-run:["thread-1","turn-1","tool-1"]:00000002'],
      ["task.completed", 'opencode-run:["thread-1","turn-1","tool-1"]:00000003'],
      ["task.started", 'opencode-run:["thread-1","turn-1","tool-1"]:00000004'],
      ["task.completed", 'opencode-run:["thread-1","turn-1","tool-1"]:00000005'],
      ["task.completed", 'opencode-run:["thread-1","turn-1","tool-1"]:00000006'],
    ]);
    expect(events[0]?.payload).toEqual({
      taskId: "opencode-run:tool-1:ses_child_1",
      description: "Multiply numbers",
      taskType: "subagent",
      title: "Multiply numbers",
      role: "flash",
      model: "opencode-go/deepseek-v4.1-flash",
      toolUseId: "tool-1",
    });
    expect(events[3]?.payload).toMatchObject({
      taskId: "opencode-run:tool-1:ses_child_2",
      status: "failed",
      summary: "Task failed",
    });
    expect(events[4]?.payload).toEqual({
      taskId: "opencode-run:tool-1",
      status: "completed",
      summary: "Both tasks finished: 391 and a failure.",
      typedUsage: {
        totalTokens: 160,
        inputTokens: 130,
        cachedInputTokens: 30,
        outputTokens: 25,
        reasoningOutputTokens: 5,
        toolUses: 3,
        durationMs: 1_000,
      },
      taskType: "subagent",
      title: "Run both tasks",
      role: "opencode",
      model: "opencode-go/deepseek-v4.1-flash",
      toolUseId: "tool-1",
    });
  });

  it("starts and settles in one go when the command was never seen before", () => {
    const events = deriveOpenCodeRunEvents(
      claudeItem(
        "item.completed",
        { command: "opencode run 'Say hi'" },
        { status: "failed", result: { content: [{ type: "text", text: "boom" }], is_error: true } },
      ),
      { started: false },
    );
    expect(events.map((event) => event.type)).toEqual(["task.started", "task.completed"]);
    expect(events[1]?.payload).toMatchObject({
      taskId: "opencode-run:tool-1",
      status: "failed",
      summary: "boom",
      title: "Say hi",
    });
  });

  it.each(["stdout", "output", "content", "acp"])(
    "reads fallback %s when item metadata has no aggregated output",
    (outputKey) => {
      const events = deriveOpenCodeRunEvents(
        {
          ...base,
          type: "item.completed",
          eventId: EventId.make("evt-raw-output"),
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              item: { command, exitCode: 0 },
              ...(outputKey === "content"
                ? { content: [{ type: "text", text: runJsonOutput }] }
                : outputKey === "acp"
                  ? {
                      content: [
                        { type: "content", content: { type: "text", text: runJsonOutput } },
                      ] satisfies ToolCallContent[],
                    }
                  : { rawOutput: { [outputKey]: runJsonOutput } }),
            },
          },
        },
        { started: true },
      );
      expect(events).toHaveLength(5);
      expect(events[0]?.payload).toMatchObject({ taskId: "opencode-run:tool-1:ses_child_1" });
      expect(events[4]?.payload).toMatchObject({
        summary: "Both tasks finished: 391 and a failure.",
        typedUsage: { totalTokens: 160 },
      });
    },
  );

  it("preserves an explicitly empty aggregated output over fallbacks", () => {
    const events = deriveOpenCodeRunEvents(
      {
        ...base,
        type: "item.completed",
        eventId: EventId.make("evt-empty-output"),
        payload: {
          itemType: "command_execution",
          status: "completed",
          data: { item: { command, aggregatedOutput: "" }, rawOutput: { stdout: runJsonOutput } },
        },
      },
      { started: true },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).not.toHaveProperty("summary");
    expect(events[0]?.payload).not.toHaveProperty("typedUsage");
  });

  it("reads Codex and ACP shaped command items", () => {
    const codex = deriveOpenCodeRunEvents(
      {
        ...base,
        provider: ProviderDriverKind.make("codex"),
        type: "item.completed",
        eventId: EventId.make("evt-codex"),
        payload: {
          itemType: "command_execution",
          status: "completed",
          data: {
            item: {
              type: "commandExecution",
              command: "opencode run 'Codex says hi'",
              aggregatedOutput: "hi from opencode",
              exitCode: 0,
            },
          },
        },
      },
      { started: false },
    );
    expect(codex[1]?.payload).toMatchObject({
      status: "completed",
      summary: "hi from opencode",
      title: "Codex says hi",
    });

    const acp = deriveOpenCodeRunEvents(
      {
        ...base,
        provider: ProviderDriverKind.make("cursor"),
        type: "item.completed",
        eventId: EventId.make("evt-acp"),
        payload: {
          itemType: "command_execution",
          status: "completed",
          data: {
            toolCallId: "tool-call-1",
            kind: "execute",
            command: "opencode run 'Cursor says hi'",
            rawOutput: { stdout: "hi from cursor" },
          },
        },
      },
      { started: false },
    );
    expect(acp[1]?.payload).toMatchObject({ summary: "hi from cursor", title: "Cursor says hi" });
  });
});
