import { describe, expect, it } from "@effect/vitest";
import {
  RunAttemptId,
  GuestItemDetail,
  GuestStreamEvent,
  type GuestTurnItem,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT } from "@t3tools/shared/terminalOutput";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  coalesceGuestEvents,
  guestCommandOutputFrames,
  guestPathRoots,
  guestRunTurnEnded,
  guestThreadModel,
  projectSnapshotForGuest,
  projectTurnItemForGuest,
  projectTurnItemForGuestDetail,
} from "./guestProjection.ts";

const HOME = "/Users/owner";
const ROOT = `${HOME}/code/secret-project`;
const roots = guestPathRoots([`${ROOT}/`, null], HOME);
const updatedAt = DateTime.makeUnsafe(0);

const domainBase = {
  id: "item",
  threadId: "thread",
  runId: "run",
  nodeId: "node",
  providerThreadId: "provider-thread",
  providerTurnId: "provider-turn",
  nativeItemRef: { driver: "codex", nativeId: "native", strength: "strong" },
  parentItemId: null,
  ordinal: 3,
  status: "completed",
  title: `cat ${ROOT}/.env`,
  startedAt: null,
  completedAt: null,
  updatedAt,
  toolSource: { key: "browser", name: "Browser", kind: "browser" },
};
const item = (fields: Record<string, unknown>) =>
  ({ ...domainBase, ...fields }) as unknown as OrchestrationV2TurnItem;

const guestBase = {
  id: "item",
  threadId: "thread",
  runId: "run",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 3,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt,
};
const guest = (fields: Record<string, unknown>) => ({ ...guestBase, ...fields });

const htmlRender = { attachmentId: "thread-a-1", title: "Chart", height: 320 };

// One case per item type the guest sees: the domain item, then exactly what reaches the guest.
const SHOWN: ReadonlyArray<readonly [string, Record<string, unknown>, Record<string, unknown>]> = [
  [
    "a message a person typed, without context records or attachments",
    {
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      messageId: "message",
      inputIntent: "turn_start",
      text: "Look at @terminal",
      context: { version: 1, records: [{ kind: "terminal", contextId: "c", output: "TOKEN=1" }] },
      attachments: [
        { type: "image", id: "a", name: "screen.png", mimeType: "image/png", sizeBytes: 1 },
      ],
    },
    {
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      messageId: "message",
      inputIntent: "turn_start",
      text: "Look at @terminal",
      attachments: [],
    },
  ],
  [
    "a guest's message, with its attribution",
    {
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      messageId: "message",
      inputIntent: "turn_start",
      text: "Message from guest Sam, sent by the owner:\n\nWhy?",
      context: {
        version: 1,
        records: [],
        guest: { guestMessageId: "guest-message:one", name: "Sam", text: "Why?" },
      },
      attachments: [],
    },
    {
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      messageId: "message",
      inputIntent: "turn_start",
      text: "Message from guest Sam, sent by the owner:\n\nWhy?",
      context: {
        version: 1,
        records: [],
        guest: { guestMessageId: "guest-message:one", name: "Sam", text: "Why?" },
      },
      attachments: [],
    },
  ],
  [
    "a streaming reply, without attachments",
    {
      type: "assistant_message",
      messageId: "message",
      text: "Hel",
      streaming: true,
      attachments: [{ type: "image", id: "a", name: "x.png", mimeType: "image/png", sizeBytes: 1 }],
    },
    { type: "assistant_message", messageId: "message", text: "Hel", streaming: true },
  ],
  [
    "a plan",
    { type: "proposed_plan", planId: "plan", markdown: "1. Fix it", streaming: false },
    { type: "proposed_plan", planId: "plan", markdown: "1. Fix it", streaming: false },
  ],
  [
    "the agent's question, without the owner's answer",
    {
      type: "user_input_request",
      requestId: "request",
      questions: [
        {
          id: "q",
          header: "Cache",
          question: "Keep it?",
          options: [{ label: "Yes", description: "Keep", preview: "secret preview" }],
          initialAnswer: "Yes",
        },
      ],
      questionAnswer: { requestId: "request", answers: {} },
    },
    {
      type: "user_input_request",
      requestId: "request",
      questions: [
        {
          id: "q",
          header: "Cache",
          question: "Keep it?",
          options: [{ label: "Yes", description: "Keep" }],
        },
      ],
    },
  ],
  [
    "a file change as relative paths and counts, without the diff",
    {
      type: "file_change",
      fileName: `${ROOT}/src/auth.ts`,
      additions: 3,
      deletions: 1,
      diffStr: "+TOKEN=1",
      oldStr: "old",
      newStr: "new",
      changes: [
        { operation: "update", path: `${ROOT}/src/auth.ts`, oldPath: `${ROOT}/src/old.ts` },
        { operation: "add", path: "/etc/hosts", mimeType: "text/plain" },
      ],
    },
    {
      type: "file_change",
      fileName: "src/auth.ts",
      additions: 3,
      deletions: 1,
      changes: [
        { operation: "update", path: "src/auth.ts", oldPath: "src/old.ts" },
        { operation: "add", path: "hosts" },
      ],
    },
  ],
  [
    "a command and how it ended, with its output left for the expanded row",
    {
      type: "command_execution",
      input: `cd ${ROOT} && cat ${ROOT}/.env && cd "${ROOT}/" && ls ${ROOT}/ ${HOME}/.config/app.json`,
      output: "TOKEN=1",
      exitCode: 1,
    },
    {
      type: "command_execution",
      input: 'cd . && cat .env && cd "." && ls . ~/.config/app.json',
      outputIndicatesFailure: true,
      outputOmitted: true,
      exitCode: 1,
    },
  ],
  [
    "a file search as its pattern and file names, without previews",
    {
      type: "file_search",
      pattern: `TOKEN in ${ROOT}`,
      results: [{ fileName: `${ROOT}/.env`, line: 1, preview: "TOKEN=1" }],
    },
    {
      type: "file_search",
      pattern: "TOKEN in .",
      results: [{ fileName: ".env", line: 1 }],
    },
  ],
  [
    "a web search as its queries, titles, and links, without snippets",
    {
      type: "web_search",
      patterns: ["effect schema", `error in ${ROOT}/src`],
      results: [{ title: "Effect", url: "https://effect.website", snippet: "text" }],
    },
    {
      type: "web_search",
      patterns: ["effect schema", "error in src"],
      results: [{ title: "Effect", url: "https://effect.website" }],
    },
  ],
  [
    "an approval as a row, without its prompt or choices",
    {
      type: "approval_request",
      requestId: "request",
      requestKind: "command",
      prompt: "Run rm -rf?",
      reason: "cleanup",
      options: [{ id: "allow", label: "Allow" }],
    },
    { type: "approval_request", requestId: "request", requestKind: "command" },
  ],
  [
    "a notice",
    { type: "system_notice", message: `Restarted in ${ROOT}` },
    { type: "system_notice", message: "Restarted in ." },
  ],
  [
    "an interrupt",
    { type: "run_interrupt_request", message: "Stopping" },
    { type: "run_interrupt_request", message: "Stopping" },
  ],
  [
    "an error",
    {
      type: "error",
      failure: { class: "provider_error", message: "Overloaded", code: null, retryable: true },
      retry: { attempt: 1, maxAttempts: 3, retryDelayMs: 100 },
    },
    {
      type: "error",
      failure: { class: "provider_error", message: "Overloaded", code: null, retryable: true },
      retry: { attempt: 1, maxAttempts: 3, retryDelayMs: 100 },
    },
  ],
  [
    "a compaction without its summary",
    {
      type: "compaction",
      driver: "codex",
      summary: "Earlier the agent read .env",
      beforeTokenCount: 100,
      afterTokenCount: 10,
    },
    { type: "compaction", driver: "codex", beforeTokenCount: 100, afterTokenCount: 10 },
  ],
  [
    "a subagent without its prompt, result, or thread",
    {
      type: "subagent",
      subagentId: "node",
      origin: "provider_native",
      driver: "codex",
      providerInstanceId: "codex",
      childThreadId: "thread:child",
      prompt: "Read .env",
      progress: "Reading",
      result: "TOKEN=1",
    },
    {
      type: "subagent",
      subagentId: "node",
      origin: "provider_native",
      driver: "codex",
      providerInstanceId: "codex",
      childThreadId: null,
      prompt: "",
      result: null,
    },
  ],
  [
    "a tool call as its name, without input or output",
    {
      type: "dynamic_tool",
      toolName: "mcp__docs__lookup",
      input: { path: `${ROOT}/.env` },
      output: "TOKEN=1",
      viewedImagePath: `${ROOT}/shot.png`,
    },
    { type: "dynamic_tool", toolName: "mcp__docs__lookup", input: null },
  ],
  [
    "an MCP app as a plain tool row, so its frame never mounts",
    {
      type: "dynamic_tool",
      toolName: "docs.dashboard",
      input: {},
      output: { t3McpApp: { server: "docs", tool: "dashboard", attachmentId: "app-1" } },
    },
    { type: "dynamic_tool", toolName: "docs.dashboard", input: null },
  ],
  [
    "a published visual by reference",
    {
      type: "dynamic_tool",
      toolName: "mcp__t3-code__html_render",
      input: { html: "<p>secret</p>" },
      output: [{ type: "text", text: JSON.stringify({ htmlRender }) }],
    },
    {
      type: "dynamic_tool",
      toolName: "mcp__t3-code__html_render",
      input: null,
      output: { htmlRender },
    },
  ],
];

const encodeEvent = Schema.encodeUnknownSync(GuestStreamEvent);

describe("projectTurnItemForGuest", () => {
  it.each(SHOWN)("shows %s", (_name, domain, expected) => {
    const projected = projectTurnItemForGuest(item(domain), roots);
    expect(projected).toEqual(guest(expected));
    // The stream schema accepts exactly what the projector builds.
    expect(encodeEvent({ type: "item", item: projected })).toMatchObject({ type: "item" });
  });

  it.each([
    ["a scheduled message", { type: "user_message", createdBy: "user", scheduledTaskId: "task" }],
    ["another thread's message", { type: "user_message", createdBy: "user", senderThreadId: "t" }],
    ["an agent's message", { type: "user_message", createdBy: "agent" }],
    ["a workflow script", { type: "user_message", createdBy: "user", workflowScript: true }],
    ["a secret request", { type: "secret_request", label: "API key", reason: "deploy" }],
    ["a fork", { type: "fork", targetThreadId: "thread:fork" }],
    ["a handoff", { type: "handoff", summary: "everything so far" }],
    ["a notification", { type: "notification", summary: "child finished", detail: "result" }],
    ["a created thread", { type: "thread_created", targetThreadId: "thread:child" }],
    ["a todo list", { type: "todo_list", steps: [] }],
    ["reasoning", { type: "reasoning", text: "The .env holds TOKEN=1", streaming: false }],
    ["a checkpoint", { type: "checkpoint", files: [] }],
    ["a type this build does not know", { type: "future_item", text: "hidden" }],
    ["an item outside a run", { type: "assistant_message", runId: null, text: "hidden" }],
  ])("drops %s", (_name, domain) => {
    expect(projectTurnItemForGuest(item(domain), roots)).toBeNull();
  });

  it("never sends the workspace root", () => {
    const sent = SHOWN.flatMap(([, domain]) => {
      const projected = projectTurnItemForGuest(item(domain), roots);
      return projected === null
        ? []
        : [JSON.stringify(encodeEvent({ type: "item", item: projected }))];
    });
    expect(sent).toHaveLength(SHOWN.length);
    for (const json of sent) expect(json).not.toContain(HOME);
  });

  it("shows a sibling of the workspace under ~, and other absolute paths by base name", () => {
    const sibling = projectTurnItemForGuest(
      item({ type: "file_change", fileName: `${ROOT}-old/src/a.ts` }),
      roots,
    );
    expect(sibling).toMatchObject({ fileName: "~/code/secret-project-old/src/a.ts" });
    const outside = projectTurnItemForGuest(
      item({ type: "file_change", fileName: "/etc/ssl/key.pem" }),
      roots,
    );
    expect(outside).toMatchObject({ fileName: "key.pem" });
  });
});

describe("projectTurnItemForGuestDetail", () => {
  const encodeDetail = Schema.encodeUnknownSync(GuestItemDetail);

  it("adds a command's output, with paths as in its command text", () => {
    const detail = projectTurnItemForGuestDetail(
      item({
        type: "command_execution",
        input: `ls ${ROOT}/src`,
        output: `${ROOT}/src/auth.ts\n\u001b[32m${HOME}\u001b[0m/.config/app.json\n`,
        exitCode: 0,
      }),
      roots,
    );
    expect(detail).toEqual(
      guest({
        type: "command_execution",
        input: "ls src",
        outputOmitted: true,
        exitCode: 0,
        output: "src/auth.ts\n~/.config/app.json\n",
      }),
    );
    expect(JSON.stringify(encodeDetail({ item: detail }))).not.toContain(HOME);
  });

  it("adds nothing to other items the owner's detail would fill in", () => {
    const search = item({
      type: "file_search",
      pattern: "TOKEN",
      results: [{ fileName: `${ROOT}/.env`, preview: "TOKEN=1" }],
    });
    expect(projectTurnItemForGuestDetail(search, roots)).toEqual(
      projectTurnItemForGuest(search, roots),
    );
    const tool = item({
      type: "dynamic_tool",
      toolName: "fetch",
      input: { url: "x" },
      output: "y",
    });
    expect(projectTurnItemForGuestDetail(tool, roots)).toMatchObject({ input: null });
    expect(
      projectTurnItemForGuestDetail(item({ type: "reasoning", text: "TOKEN=1" }), roots),
    ).toBeNull();
  });
});

describe("guestCommandOutputFrames", () => {
  const frame = (kind: "replace" | "append", text: string, running = true) => ({
    kind,
    text,
    truncated: false,
    running,
  });
  /** The text a client holds after applying the frames, as it does for the owner's. */
  const shown = (frames: ReadonlyArray<ReturnType<typeof frame> | null>) =>
    frames.reduce(
      (state, next) =>
        next === null
          ? state
          : appendTerminalOutput(
              next.kind === "replace" ? EMPTY_TERMINAL_OUTPUT : state,
              next.text,
            ),
      EMPTY_TERMINAL_OUTPUT,
    ).text;

  it("rewrites a root split across frames whole", () => {
    const rewrite = guestCommandOutputFrames(roots);
    const frames = [
      rewrite(frame("replace", "")),
      rewrite(frame("append", `built ${ROOT.slice(0, 9)}`)),
      rewrite(frame("append", `${ROOT.slice(9)}`)),
      rewrite(frame("append", "/dist/app.js\n")),
    ];
    expect(frames.map((next) => next?.text)).toEqual(["", "built ", undefined, "dist/app.js\n"]);
    expect(shown(frames)).toBe("built dist/app.js\n");
  });

  it("tells a sibling of the root apart once the next frame shows it", () => {
    const rewrite = guestCommandOutputFrames(roots);
    const frames = [rewrite(frame("append", `cp ${ROOT}`)), rewrite(frame("append", "-old/a .\n"))];
    expect(shown(frames)).toBe("cp ~/code/secret-project-old/a .\n");
  });

  it("sends plain text, so colors inside a path cannot hide it", () => {
    const color = (text: string) => `\u001b[01;31m\u001b[K${text}\u001b[m\u001b[K`;
    const colored = `${ROOT.slice(0, 7)}${color("owner")}${ROOT.slice(12)}/private.txt\n`;
    expect(ROOT.slice(7, 12)).toBe("owner");
    const rewrite = guestCommandOutputFrames(roots);
    const frames = [
      rewrite(frame("replace", "")),
      // The frame boundary falls inside an escape sequence.
      rewrite(frame("append", colored.slice(0, 10))),
      rewrite(frame("append", colored.slice(10))),
    ];
    expect(shown(frames)).toBe("private.txt\n");
    const link = `\u001b]8;;file://${ROOT}/a.ts\u0007a.ts\u001b]8;;\u0007\n`;
    expect(shown([rewrite(frame("replace", link, false))])).toBe("a.ts\n");
  });

  it("rewrites what the terminal displays, so backspaces and overstrikes cannot rebuild a path", () => {
    const backspace = guestCommandOutputFrames(roots);
    expect(
      shown([backspace(frame("replace", `${ROOT.slice(0, 9)}X\b${ROOT.slice(9)}/a.txt\n`))]),
    ).toBe("a.txt\n");
    const overstrike = guestCommandOutputFrames(roots);
    const frames = [
      overstrike(frame("replace", `${"X".repeat(9)}${ROOT.slice(9)}/a.txt`)),
      overstrike(frame("append", `\r${ROOT.slice(0, 9)}`)),
      overstrike(frame("append", "\n")),
    ];
    expect(shown(frames)).toBe("a.txt\n");
    for (const next of frames) expect(next?.text ?? "").not.toContain("owner");
  });

  it("keeps sending output after escapes it does not show", () => {
    const rewrite = guestCommandOutputFrames(roots);
    const frames = [
      rewrite(frame("replace", "\u001b7ready\n")),
      rewrite(frame("append", "\u001b(Bnext line\n")),
    ];
    expect(shown(frames)).toBe("ready\nnext line\n");
  });

  /** The guest's client after the frames, as `applyCommandOutputFrame` builds it. */
  const client = (frames: ReadonlyArray<OrchestrationV2CommandOutputFrame | null>) =>
    frames.reduce(
      (state, next) =>
        next === null
          ? state
          : appendTerminalOutput(
              {
                ...(next.kind === "replace" ? EMPTY_TERMINAL_OUTPUT : state),
                truncated: (next.kind === "replace" ? false : state.truncated) || next.truncated,
              },
              next.text,
            ),
      EMPTY_TERMINAL_OUTPUT,
    );

  it("keeps a long log exact once its tail starts dropping lines", () => {
    const rewrite = guestCommandOutputFrames(roots);
    const line = (index: number) => `line ${String(index).padStart(6, "0")} ${"x".repeat(1009)}\n`;
    const frames = Array.from({ length: 200 }, (_, index) =>
      rewrite(frame(index === 0 ? "replace" : "append", line(index))),
    );
    // Before the tail fills, growth is appended.
    expect(frames.slice(1, 30).every((next) => next?.kind === "append")).toBe(true);
    const owner = frames.reduce(
      (state, _next, index) => appendTerminalOutput(state, line(index)),
      EMPTY_TERMINAL_OUTPUT,
    );
    const state = client(frames);
    expect(state.truncated).toBe(true);
    expect(state.text).toBe(owner.text);
  });

  it("redraws only the lines a progress bar or a multi-line reporter changed", () => {
    const rewrite = guestCommandOutputFrames(roots);
    const frames = [rewrite(frame("replace", "start\n".repeat(500)))];
    for (let percent = 1; percent <= 100; percent += 1) {
      frames.push(rewrite(frame("append", `\rDownloading ${percent}%`)));
    }
    frames.push(rewrite(frame("append", "\ntest a ...\ntest b ...")));
    frames.push(rewrite(frame("append", "\u001b[1A\rtest a ok\u001b[K\ntest b ok\u001b[K")));
    for (const next of frames.slice(1)) expect(next!.text.length).toBeLessThan(64);
    expect(client(frames).text.endsWith("Downloading 100%\ntest a ok\ntest b ok")).toBe(true);
  });

  it("replaces what a cleared screen erased instead of keeping it above the new output", () => {
    const cleared = guestCommandOutputFrames(roots);
    const frames = [cleared(frame("replace", "old\n")), cleared(frame("append", "\u001b[2Jnew\n"))];
    expect(client(frames).text).toBe("new\n");
    const emptied = guestCommandOutputFrames(roots);
    const empty = [emptied(frame("replace", "old\n")), emptied(frame("append", "\u001b[2J"))];
    expect(client(empty).text).toBe("");
  });

  it("clears what the terminal cleared from its scrollback, even on a long tail", () => {
    const rewrite = guestCommandOutputFrames(roots);
    const suffix = `${"x".repeat(1023)}\n`.repeat(40);
    const frames = [
      rewrite(frame("replace", `${"discard\n".repeat(8192)}OLD\n${suffix}`)),
      // The escape is split across frames.
      rewrite(frame("append", "\u001b[3")),
      rewrite(frame("append", `J\u001b[2J${suffix}`)),
    ];
    expect(client(frames).text).toBe(suffix);
    frames.push(rewrite(frame("replace", suffix, false)));
    expect(client(frames).text).toBe(suffix);
  });

  it("never keeps a line a screen erase removed from a full tail", () => {
    const line = `${"x".repeat(1600)}\n`;
    const rewrite = guestCommandOutputFrames(roots);
    const frames = [
      rewrite(frame("replace", `${line.repeat(90)}OLD\n${line.repeat(40)}`)),
      rewrite(frame("append", "\u001b[2J", false)),
    ];
    expect(client(frames).text).not.toContain("OLD");
    const split = guestCommandOutputFrames(roots);
    const suffix = `${"x".repeat(1023)}\n`.repeat(40);
    const cleared = [
      split(frame("replace", `${"discard\n".repeat(8192)}OLD\n${suffix}`)),
      split(frame("append", "\u001b[3")),
      split(frame("append", `;1J\u001b[2J${suffix}`, false)),
    ];
    expect(client(cleared).text).toBe(suffix);
  });

  it("does not redraw past a live window an erase made shorter", () => {
    const rewrite = guestCommandOutputFrames(roots);
    const frames = [
      rewrite(frame("replace", `${"a\n".repeat(70)}old`)),
      rewrite(frame("append", "\u001b[2J")),
      rewrite(frame("append", "\u001b[3Jab\n")),
    ];
    expect(client(frames).text).toBe("ab\n");
    frames.push(rewrite(frame("replace", "ab\n", false)));
    expect(client(frames).text).toBe("ab\n");
  });

  it("falls back to a replace when repeated lines make the overlap ambiguous", () => {
    const rewrite = guestCommandOutputFrames(roots);
    const frames = [
      rewrite(frame("replace", "a\n".repeat(32_768))),
      rewrite(frame("append", "b\n".repeat(4096))),
    ];
    expect(client(frames).text.endsWith(`a\n${"b\n".repeat(4096)}`)).toBe(true);
  });

  it("reports output that scrolled out even when the visible text did not change", () => {
    const rewrite = guestCommandOutputFrames(roots);
    const first = rewrite(frame("replace", "ready"));
    const next = rewrite({ kind: "append", text: "", truncated: true, running: true });
    expect(next).toMatchObject({ kind: "append", text: "", truncated: true });
    expect(client([first, next]).truncated).toBe(true);
  });

  it("holds nothing back once the command settles", () => {
    const rewrite = guestCommandOutputFrames(roots);
    const frames = [rewrite(frame("append", `cd ${ROOT}`))];
    frames.push(rewrite(frame("replace", `cd ${ROOT}`, false)));
    expect(frames.at(-1)?.running).toBe(false);
    expect(shown(frames)).toBe("cd .");
  });
});

describe("guestThreadModel", () => {
  const providers = [
    {
      instanceId: "claude-work",
      driver: "claudeAgent",
      models: [
        {
          slug: "claude-opus",
          name: "Claude Opus",
          shortName: "Opus",
          isCustom: false,
          capabilities: null,
        },
      ],
    },
  ] as unknown as Parameters<typeof guestThreadModel>[1];

  it("names the model as the owner's picker does, or by its id when it is not listed", () => {
    const selection = (instanceId: string, model: string) =>
      ({ instanceId, model }) as Parameters<typeof guestThreadModel>[0];
    expect(guestThreadModel(selection("claude-work", "claude-opus"), providers)).toEqual({
      driver: "claudeAgent",
      name: "Claude Opus",
      shortName: "Opus",
    });
    expect(guestThreadModel(selection("removed", "gpt-5"), providers)).toEqual({
      driver: null,
      name: "gpt-5",
    });
  });
});

describe("guest stream encoding", () => {
  const projected = projectTurnItemForGuest(
    item({ type: "command_execution", input: "ls", output: "secret" }),
    roots,
  ) as GuestTurnItem;

  it("drops keys the guest schema does not declare", () => {
    const encoded = encodeEvent({
      type: "item",
      item: { ...projected, output: "TOKEN=1", title: null, worktreePath: ROOT },
    });
    expect(JSON.stringify(encoded)).not.toContain("TOKEN=1");
    expect(JSON.stringify(encoded)).not.toContain(HOME);
  });

  it("refuses a field the projector should have blanked", () => {
    expect(() =>
      encodeEvent({ type: "item", item: { ...projected, title: "cat .env" } }),
    ).toThrow();
    // A type the schema does not declare cannot be sent at all.
    expect(() =>
      encodeEvent({ type: "item", item: { ...projected, type: "reasoning", text: "TOKEN=1" } }),
    ).toThrow();
  });
});

describe("projectSnapshotForGuest", () => {
  const run = (id: string, ordinal: number) =>
    ({
      id,
      ordinal,
      status: "completed",
      requestedAt: updatedAt,
      startedAt: updatedAt,
      completedAt: null,
    }) as unknown as OrchestrationV2Run;
  const row = (
    id: string,
    runId: string,
    visibility: OrchestrationV2ProjectedTurnItem["visibility"] = "local",
  ) =>
    ({
      position: 0,
      visibility,
      sourceThreadId: "thread",
      sourceItemId: id,
      item: item({
        id,
        runId,
        type: "assistant_message",
        messageId: id,
        text: id,
        streaming: false,
      }),
    }) as OrchestrationV2ProjectedTurnItem;

  it("keeps only this thread's items in runs from the history window on", () => {
    const snapshot = projectSnapshotForGuest(
      {
        runs: [run("run:before", 1), run("run:shared", 2)],
        providerTurns: [],
        visibleTurnItems: [
          row("before", "run:before"),
          row("inherited", "run:shared", "inherited"),
          row("shared", "run:shared"),
        ],
      },
      2,
      roots,
    );
    expect(snapshot.runs.map((guestRun) => guestRun.id)).toEqual(["run:shared"]);
    expect(snapshot.items.map((guestItem) => guestItem.id)).toEqual(["shared"]);
    expect(snapshot.runs[0]).toEqual({
      id: "run:shared",
      ordinal: 2,
      status: "completed",
      requestedAt: "1970-01-01T00:00:00.000Z",
      startedAt: "1970-01-01T00:00:00.000Z",
      completedAt: null,
      workStartedAt: "1970-01-01T00:00:00.000Z",
      turnEnded: false,
    });
  });
});

describe("coalesceGuestEvents", () => {
  const reply = (id: string, text: string) =>
    ({
      type: "item",
      item: guest({ id, type: "assistant_message", messageId: id, text, streaming: true }),
    }) as unknown as GuestStreamEvent;

  it("keeps each item's last update where it first appeared and stops at ended", () => {
    expect(
      coalesceGuestEvents([
        reply("a", "H"),
        reply("b", "New"),
        reply("a", "Hello"),
        { type: "ended" },
        reply("a", "late"),
      ]),
    ).toEqual([reply("a", "Hello"), reply("b", "New"), { type: "ended" }]);
  });
});

describe("guestRunTurnEnded", () => {
  const attempt = RunAttemptId.make("attempt-1");
  const turn = (ordinal: number, status: "running" | "completed") => ({
    runAttemptId: attempt,
    ordinal,
    status,
  });

  it("reports a finished reply while the run is still waiting on its checkpoint", () => {
    const waiting = { status: "waiting", activeAttemptId: attempt } as const;
    expect(guestRunTurnEnded(waiting, [turn(1, "completed")])).toBe(true);
    expect(guestRunTurnEnded(waiting, [turn(1, "completed"), turn(2, "running")])).toBe(false);
    expect(guestRunTurnEnded({ ...waiting, status: "completed" }, [turn(1, "completed")])).toBe(
      false,
    );
  });
});
