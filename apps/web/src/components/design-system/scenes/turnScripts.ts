import { MessageId } from "@t3tools/contracts";

import type { ItemBody, Step } from "./playback";

/**
 * Turns scripted the way each provider adapter reports them. Codex wraps
 * commands in a login shell and sends diffs as patches; Claude's Read and Grep
 * are dynamic tools with their raw input; a stopped or failed turn ends the
 * run the way the server does.
 */

export interface TurnScript {
  readonly id: string;
  readonly title: string;
  readonly steps: ReadonlyArray<Step>;
}

/** The scenes' checkout, shown where the composer names the workspace. */
export const SCENE_WORKSPACE = { cwd: "/Users/julius/Development/t3code", branch: "main" };
const ROOT = SCENE_WORKSPACE.cwd;
const COMPOSER = `${ROOT}/apps/web/src/components/chat/ChatComposer.tsx`;

const codexCommand = (command: string): ItemBody => ({
  type: "command_execution",
  input: `/bin/zsh -lc '${command}'`,
});
const claudeTool = (toolName: string, input: Record<string, unknown>): ItemBody => ({
  type: "dynamic_tool",
  toolName,
  input,
});
const reasoning = (text: string): ItemBody => ({ type: "reasoning", text, streaming: true });
/** Reasoning that arrives in two paragraphs before it settles. */
function think(key: string, first: string, second: string, seconds = 2): Step[] {
  return [
    { kind: "start", key, body: reasoning(first) },
    { kind: "update", key, patch: { text: `${first}\n\n${second}` } as Partial<ItemBody> },
    { kind: "finish", key, seconds },
  ];
}
const assistant = (key: string, text: string): ItemBody => ({
  type: "assistant_message",
  messageId: MessageId.make(`assistant:${key}`),
  text,
  streaming: true,
});
const patch = (path: string, added: number, removed: number): ItemBody => ({
  type: "file_change",
  fileName: path,
  diffStr: [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed} +1,${added} @@`,
    ...Array.from({ length: removed }, (_, index) => `-old line ${index}`),
    ...Array.from({ length: added }, (_, index) => `+new line ${index}`),
  ].join("\n"),
});

/** A step pair for an item that starts and then settles. */
function run(
  key: string,
  body: ItemBody,
  options: { seconds?: number; status?: "completed" | "failed"; settle?: Partial<ItemBody> } = {},
): Step[] {
  return [
    { kind: "start", key, body },
    {
      kind: "finish",
      key,
      ...(options.seconds === undefined ? {} : { seconds: options.seconds }),
      ...(options.status ? { status: options.status } : {}),
      ...(options.settle ? { patch: options.settle } : {}),
    },
  ];
}

/**
 * An assistant message as the provider streams it: each update adds the next
 * paragraph and the start of the one after, the way tokens arrive mid-block.
 * Paragraph streaming (the server default) shows only whole blocks until the
 * message settles.
 */
function say(key: string, ...paragraphs: string[]): Step[] {
  const partial = (index: number) => {
    const done = paragraphs.slice(0, index).join("\n\n");
    const next = paragraphs[index];
    if (next === undefined) return done;
    const head = next.slice(0, Math.ceil(next.length / 2));
    return done ? `${done}\n\n${head}` : head;
  };
  return [
    { kind: "start", key, body: assistant(key, partial(0)) },
    ...paragraphs.slice(1).map((_, index): Step => ({
      kind: "update",
      key,
      patch: { text: partial(index + 1) } as Partial<ItemBody>,
    })),
    { kind: "finish", key, patch: { text: paragraphs.join("\n\n") } as Partial<ItemBody> },
  ];
}

export const turnScripts: ReadonlyArray<TurnScript> = [
  {
    id: "codex-edit",
    title: "Codex · read, edit, test",
    steps: [
      { kind: "turn", prompt: "Tighten the composer footer so the controls stay in one strip." },
      ...think(
        "think",
        "Looking at how the footer lays out its controls.",
        "The strip breaks because the picker and traits each measure the window instead of the footer.",
        3,
      ),
      ...run(
        "read-1",
        codexCommand("sed -n '1,240p' apps/web/src/components/chat/ChatComposer.tsx"),
      ),
      ...run("read-2", codexCommand("cat apps/web/src/components/composerFooterLayout.ts")),
      ...run("search", codexCommand("rg -n composerControlsInStrip apps/web/src"), {
        settle: { exitCode: 0 },
      }),
      ...run("edit", patch("apps/web/src/components/chat/ChatComposer.tsx", 42, 18), {
        seconds: 2,
      }),
      ...run("test", codexCommand("pnpm vitest run ChatComposer"), {
        seconds: 8,
        settle: { exitCode: 0, output: " ✓ 42 passed (1.8s)" },
      }),
      ...say(
        "answer",
        "The footer now keeps its controls in one strip. The model picker, traits and send button share a row, and the row wraps only below 360px.",
        "**What changed**",
        "- `ChatComposer` renders the controls through `composerControlsInStrip`\n- The overflow menu takes whatever does not fit",
        "The ChatComposer tests pass (42).",
      ),
      { kind: "end", ending: "completed" },
    ],
  },
  {
    id: "claude-tools",
    title: "Claude · Read, Grep, Edit",
    steps: [
      { kind: "turn", prompt: "Why does the pressed sidebar row look selected?" },
      ...think(
        "think",
        "Tracing the row surface classes.",
        "Both the pressed and the selected state resolve to the same token.",
      ),
      ...run("grep", claudeTool("Grep", { pattern: "surface-sidebar-row", path: "apps/web/src" })),
      ...run(
        "read",
        claudeTool("Read", { file_path: `${ROOT}/apps/web/src/components/Sidebar.tsx` }),
      ),
      ...run("edit", {
        type: "file_change",
        fileName: `${ROOT}/apps/web/src/index.css`,
        oldStr: "  --sidebar-row-pressed: var(--sidebar-row-active);",
        newStr:
          "  --sidebar-row-pressed: color-mix(in oklab, var(--sidebar-row) 70%, var(--sidebar-row-active));\n  --sidebar-row-pressed-rim: transparent;",
      }),
      ...run(
        "bash",
        { type: "command_execution", input: "pnpm vitest run Sidebar.logic" },
        {
          seconds: 5,
          settle: { exitCode: 0 },
        },
      ),
      ...say(
        "answer",
        "The pressed row painted `--sidebar-row-active`, which is also the top stop of the selected gradient, so a pressed row read as selected.",
        "It now has its own `--sidebar-row-pressed` token, a step between the idle and selected rows:",
        "```css\n--sidebar-row-pressed: color-mix(in oklab, var(--sidebar-row) 70%, var(--sidebar-row-active));\n```",
        "The Sidebar logic tests pass.",
      ),
      { kind: "end", ending: "completed" },
    ],
  },
  {
    id: "failed-tests",
    title: "Tests fail, turn continues",
    steps: [
      { kind: "turn", prompt: "Run the composer tests." },
      ...run("test", codexCommand("pnpm vitest run ChatComposer"), {
        seconds: 6,
        status: "failed",
        settle: {
          exitCode: 1,
          output: " ✓ 40 passed\n × 2 failed\n Tests  2 failed | 40 passed (42)",
        },
      }),
      ...run("lint", codexCommand("pnpm lint apps/web"), {
        status: "failed",
        settle: { exitCode: 1, output: "apps/web/src/Foo.tsx:3:1 error no-unused-vars" },
      }),
      ...say(
        "answer",
        "Two ChatComposer tests fail, both in the footer overflow cases.",
        "Lint also flags an unused variable in `Foo.tsx`. I have not changed anything yet.",
      ),
      { kind: "end", ending: "completed" },
    ],
  },
  {
    id: "stopped",
    title: "Stopped mid-command",
    steps: [
      { kind: "turn", prompt: "Run the whole test suite." },
      ...run("read", claudeTool("Read", { file_path: `${ROOT}/package.json` })),
      { kind: "start", key: "suite", body: codexCommand("pnpm test") },
      { kind: "end", ending: "interrupted", seconds: 48 },
    ],
  },
  {
    id: "two-turns",
    title: "Two turns in a thread",
    steps: [
      { kind: "turn", prompt: "What does the work log group by?" },
      ...run(
        "read",
        claudeTool("Read", {
          file_path: `${ROOT}/apps/web/src/components/chat/MessagesTimeline.logic.ts`,
        }),
      ),
      ...say(
        "answer-1",
        "Consecutive tool calls between two messages form one group.",
        "A message, a failure or a still-running call ends the group.",
      ),
      { kind: "end", ending: "completed" },
      { kind: "turn", prompt: "Show me where." },
      ...run("grep", claudeTool("Grep", { pattern: "groupedEntries", path: "apps/web/src" })),
      ...run("read", claudeTool("Read", { file_path: COMPOSER })),
      ...say(
        "answer-2",
        "`deriveMessagesTimelineRows` builds `groupedEntries` from each run's work entries.",
        'The summary label ("Read 3 files and ran 2 commands") comes from `summarizeWorkGroup`.',
      ),
      { kind: "end", ending: "completed" },
    ],
  },
  {
    id: "steer",
    title: "Steer mid-turn",
    steps: [
      { kind: "turn", prompt: "Make the composer footer wrap on narrow widths." },
      ...think(
        "think",
        "The footer lays out with flex and never wraps.",
        "Adding flex-wrap and a gap is the smallest change.",
      ),
      ...run("read", claudeTool("Read", { file_path: COMPOSER })),
      {
        kind: "start",
        key: "edit",
        body: patch("apps/web/src/components/chat/ChatComposer.tsx", 6, 2),
      },
      {
        kind: "steer",
        key: "steer",
        text: "Actually don't wrap it, fold the extra controls into an overflow menu instead.",
      },
      { kind: "finish", key: "edit" },
      ...think(
        "rethink",
        "The user wants an overflow menu, not wrapping.",
        "Reverting the wrap and measuring the footer instead.",
      ),
      ...run("edit-2", patch("apps/web/src/components/chat/ChatComposer.tsx", 24, 8), {
        seconds: 3,
      }),
      ...run("test", codexCommand("pnpm vitest run ChatComposer"), {
        seconds: 6,
        settle: { exitCode: 0 },
      }),
      ...say(
        "answer",
        "Switched to an overflow menu: controls that do not fit move into it, and the footer stays one row.",
      ),
      { kind: "end", ending: "completed" },
    ],
  },
  {
    id: "approval",
    title: "Approval · command",
    steps: [
      { kind: "turn", prompt: "Clear the build output and rebuild." },
      ...think(
        "think",
        "The dist folder holds stale chunks from the old router.",
        "Removing it needs approval in this runtime mode.",
      ),
      {
        kind: "request",
        key: "rm",
        request: {
          kind: "approval",
          requestKind: "command",
          prompt: "rm -rf apps/web/dist && pnpm --filter web build",
          cwd: ROOT,
        },
      },
      { kind: "resolve", key: "rm", decision: "accept" },
      ...run(
        "build",
        { type: "command_execution", input: "rm -rf apps/web/dist && pnpm --filter web build" },
        {
          seconds: 9,
          settle: { exitCode: 0 },
        },
      ),
      ...say("answer", "The build output is fresh and the web build passes."),
      { kind: "end", ending: "completed" },
    ],
  },
  {
    id: "approval-file",
    title: "Approval · file change",
    steps: [
      { kind: "turn", prompt: "Rename the pressed token." },
      ...run("read", claudeTool("Read", { file_path: `${ROOT}/apps/web/src/index.css` })),
      {
        kind: "request",
        key: "edit",
        request: {
          kind: "approval",
          requestKind: "file-change",
          prompt: "Edit apps/web/src/index.css",
          gates: {
            type: "file_change",
            fileName: `${ROOT}/apps/web/src/index.css`,
            additions: 1,
            deletions: 1,
            diffStr: [
              "--- a/apps/web/src/index.css",
              "+++ b/apps/web/src/index.css",
              "@@ -212,3 +212,3 @@",
              "   --sidebar-row-hover: var(--sidebar-row);",
              "-  --sidebar-row-pressed: var(--sidebar-row-active);",
              "+  --sidebar-row-selected: var(--sidebar-row-active);",
              "   --sidebar-row-rim: transparent;",
            ].join("\n"),
          },
        },
      },
      { kind: "resolve", key: "edit", decision: "decline" },
      ...say("answer", "I left index.css as it was. Say if you want a different name."),
      { kind: "end", ending: "completed" },
    ],
  },
  {
    id: "question",
    title: "Question · two steps",
    steps: [
      { kind: "turn", prompt: "Split the composer into smaller files." },
      ...run(
        "grep",
        claudeTool("Grep", { pattern: "export function", path: "apps/web/src/components/chat" }),
      ),
      {
        kind: "request",
        key: "scope",
        request: {
          kind: "question",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which parts should move out of ChatComposer?",
              options: [
                { label: "Request cards", description: "Approvals, questions and the plan banner" },
                { label: "Attachments", description: "Tiles, uploads and previews" },
                { label: "Both", description: "Everything above the prompt field" },
              ],
            },
            {
              id: "tests",
              header: "Tests",
              question: "Move the tests with them?",
              options: [
                { label: "Yes", description: "One test file per new module" },
                { label: "No", description: "Keep ChatComposer's tests as they are" },
              ],
            },
          ],
        },
      },
      { kind: "resolve", key: "scope", answers: { scope: "Request cards", tests: "Yes" } },
      ...say("answer", "Moving the request cards out first, with their tests."),
      { kind: "end", ending: "completed" },
    ],
  },
  {
    id: "plan",
    title: "Plan ready",
    steps: [
      { kind: "turn", prompt: "Plan how to tighten the composer footer." },
      ...think(
        "think",
        "The footer has three measurement paths.",
        "One strip means one owner for the width.",
      ),
      ...run("read", claudeTool("Read", { file_path: COMPOSER })),
      {
        kind: "plan",
        key: "plan",
        markdown:
          "# Keep the composer footer in one strip\n\n1. Measure the footer, not the window\n2. Move the picker and traits into the strip\n3. Fold the overflow into a menu",
      },
      ...say("answer", "The plan is ready. Build it, or tell me what to change."),
      { kind: "end", ending: "completed" },
    ],
  },
  {
    id: "slash-commands",
    title: "Slash commands",
    steps: [
      // A command sent alone is its turn's only prompt; /compact reports one compaction item.
      { kind: "turn", prompt: "/compact" },
      { kind: "start", key: "compact", body: { type: "compaction", driver: null } },
      {
        kind: "finish",
        key: "compact",
        seconds: 4,
        patch: { beforeTokenCount: 182_400, afterTokenCount: 24_100 } as Partial<ItemBody>,
      },
      { kind: "end", ending: "completed" },
      { kind: "turn", prompt: "/feedback" },
      { kind: "end", ending: "completed" },
      { kind: "turn", prompt: "/goal ship snake with pause and a high score" },
      ...say("answer", "Starting with the pause key, then the high score in localStorage."),
      { kind: "end", ending: "completed" },
      { kind: "turn", prompt: "/init" },
      { kind: "end", ending: "failed" },
    ],
  },
  {
    id: "sparse",
    title: "Sparse · one tool, short answer",
    steps: [
      { kind: "turn", prompt: "What branch am I on?" },
      ...run("branch", codexCommand("git branch --show-current"), {
        settle: { exitCode: 0, output: "t3code/composer-tray" },
      }),
      ...say("answer", "You're on `t3code/composer-tray`."),
      { kind: "end", ending: "completed" },
    ],
  },
  {
    id: "overflow",
    title: "Overflow · long output and paths",
    steps: [
      {
        kind: "turn",
        prompt:
          "Run the full web suite and tell me which of the deeply nested composer layout helpers under apps/web/src/components/chat/composer/layout/measurements are still untested.",
      },
      ...run(
        "suite",
        codexCommand(
          "pnpm vitest run apps/web/src/components/chat/composer/layout/measurements/restingComposerControlsMeasurement.integration.test.ts --reporter=verbose",
        ),
        {
          seconds: 41,
          settle: {
            exitCode: 0,
            output: Array.from(
              { length: 120 },
              (_, index) =>
                ` ✓ apps/web/src/components/chat/composer/layout/measurements/case-${index}.test.ts (${index % 7} ms)`,
            ).join("\n"),
          },
        },
      ),
      ...say(
        "answer",
        "All 120 cases pass. Two helpers have no tests: `measureRestingControlsAgainstTheFooterWithoutTheOverflowMenu` and `composerControlsInStripWhenTheTraitsPickerIsCollapsedIntoTheOverflow`.",
      ),
      { kind: "end", ending: "completed" },
    ],
  },
];

/** Tool calls the player can add to a running turn by hand. */
export const addableSteps: ReadonlyArray<{
  readonly label: string;
  readonly steps: (key: string) => Step[];
}> = [
  { label: "Read (Claude)", steps: (key) => run(key, claudeTool("Read", { file_path: COMPOSER })) },
  {
    label: "cat (Codex)",
    steps: (key) => run(key, codexCommand("cat apps/web/src/components/chat/ChatComposer.tsx")),
  },
  {
    label: "Grep (Claude)",
    steps: (key) => run(key, claudeTool("Grep", { pattern: "composerControlsInStrip" })),
  },
  {
    label: "Edit",
    steps: (key) => run(key, patch("apps/web/src/components/chat/ChatComposer.tsx", 12, 4)),
  },
  {
    label: "Command",
    steps: (key) =>
      run(key, codexCommand("pnpm typecheck"), { seconds: 4, settle: { exitCode: 0 } }),
  },
  {
    label: "Failing command",
    steps: (key) =>
      run(key, codexCommand("pnpm lint apps/web"), {
        status: "failed",
        settle: { exitCode: 1, output: "error no-unused-vars" },
      }),
  },
  {
    label: "Web search",
    steps: (key) => run(key, { type: "web_search", patterns: ["tailwind v4 @variant"] }),
  },
  {
    label: "Thinking",
    steps: (key) =>
      think(
        key,
        "Weighing the two layouts.",
        "The single strip keeps the send button in reach.",
        3,
      ),
  },
  {
    label: "Message",
    steps: (key) =>
      say(
        key,
        "Here is what I found so far.",
        "The layout reads its width from the footer, not the window.",
      ),
  },
];
