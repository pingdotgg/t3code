/**
 * A seeded, long transcript for `vp run stress`: every turn thinks, plans, reads, runs a
 * command with long output, asks to edit, and answers with a long Markdown reply.
 */

const TURNS = 4;
const REPLY_SECTIONS = 14;

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "the timeline renders each row once while the stream appends text so finished blocks keep their layout and the list measures only what grew between frames when a reply streams the sidebar still updates every running thread".split(
    " ",
  );
const FILES = [
  "apps/web/src/components/ChatMarkdown.tsx",
  "apps/web/src/components/chat/MessagesTimeline.tsx",
  "apps/server/src/orchestration-v2/Orchestrator.ts",
  "packages/client-runtime/src/state/threadDetail.ts",
  "apps/web/src/components/pullRequest/PullRequestCodeTab.tsx",
];

function generator(seed: number) {
  const random = seeded(seed);
  const pick = <T>(values: ReadonlyArray<T>) => values[Math.floor(random() * values.length)]!;
  const words = (count: number) => Array.from({ length: count }, () => pick(WORDS)).join(" ");
  const sentence = () => {
    const text = words(8 + Math.floor(random() * 14));
    return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
  };
  const paragraph = () =>
    Array.from({ length: 2 + Math.floor(random() * 4) }, () => {
      const roll = random();
      const text = sentence();
      if (roll < 0.2) return text.replace(/ (\w+) /, " `$1` ");
      if (roll < 0.35) return text.replace(/ (\w+ \w+) /, " **$1** ");
      if (roll < 0.45)
        return `${text} See [${pick(FILES)}](${pick(FILES)}#L${10 + Math.floor(random() * 400)}).`;
      if (roll < 0.5) return `${text} Details in [the docs](https://example.com/${pick(WORDS)}).`;
      return text;
    }).join(" ");
  const code = () =>
    [
      "```ts",
      ...Array.from({ length: 6 + Math.floor(random() * 14) }, (_, line) =>
        line % 4 === 0
          ? `export function ${pick(WORDS)}${line}(input: number): number {`
          : line % 4 === 3
            ? "}"
            : `  return input * ${line} + ${Math.floor(random() * 100)}; // ${words(4)}`,
      ),
      "```",
    ].join("\n");
  const table = () =>
    [
      "| File | Change | Lines |",
      "| --- | --- | ---: |",
      ...Array.from(
        { length: 3 + Math.floor(random() * 5) },
        () => `| \`${pick(FILES)}\` | ${words(4)} | ${Math.floor(random() * 300)} |`,
      ),
    ].join("\n");
  const list = (ordered: boolean) =>
    Array.from(
      { length: 3 + Math.floor(random() * 4) },
      (_, index) => `${ordered ? `${index + 1}.` : "-"} ${sentence()}`,
    ).join("\n");
  const reply = () =>
    Array.from({ length: REPLY_SECTIONS }, (_, section) =>
      [
        `## ${sentence().slice(0, 40)} ${section + 1}`,
        paragraph(),
        pick([code, table, () => list(false), () => list(true), () => `> ${sentence()}`])(),
        paragraph(),
      ].join("\n\n"),
    ).join("\n\n");
  const terminal = () =>
    Array.from(
      { length: 120 },
      (_, line) =>
        ` ✓ ${pick(FILES).replace(".tsx", ".test.tsx")} (${line} tests) ${Math.floor(random() * 90)}ms`,
    ).join("\n");
  return { paragraph, reply, terminal, words };
}

export function stressTranscript(): string {
  const lines: Array<unknown> = [
    { type: "transcript_start", provider: "acpRegistry", scenario: "dev_replay_stress" },
  ];
  const update = (value: Record<string, unknown>, afterMs?: number) =>
    lines.push({
      type: "emit_inbound",
      frame: {
        kind: "notification",
        method: "session/update",
        params: { sessionId: "dev-replay-session", update: value },
      },
      ...(afterMs === undefined ? {} : { afterMs }),
    });
  const plan = (done: number) => ({
    sessionUpdate: "plan",
    entries: ["Read the affected files", "Edit the renderer", "Run the tests"].map(
      (content, index) => ({
        content,
        priority: "high",
        status: index < done ? "completed" : index === done ? "in_progress" : "pending",
      }),
    ),
  });
  for (let turn = 0; turn < TURNS; turn++) {
    const text = generator(turn + 1);
    lines.push({
      type: "expect_outbound",
      frame: { kind: "request", method: "session/prompt", params: "<any>" },
    });
    update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: text.paragraph() },
    });
    update(plan(0));
    for (const [index, path] of FILES.slice(0, 3).entries()) {
      const id = `read-${index}`;
      update({
        sessionUpdate: "tool_call",
        toolCallId: id,
        kind: "read",
        title: `Read ${path}`,
        status: "pending",
        rawInput: { path: `<workspace>/${path}` },
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: text.paragraph() } }],
      });
    }
    update(plan(1));
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `${text.paragraph()}\n\n` },
    });
    const edit = {
      toolCallId: "edit",
      kind: "edit",
      title: `Edit ${FILES[0]}`,
      rawInput: { path: `<workspace>/${FILES[0]}` },
    };
    const diff = {
      type: "diff",
      path: `<workspace>/${FILES[0]}`,
      oldText: `${text.words(30)}\n`,
      newText: `${text.words(30)}\n${text.words(30)}\n`,
    };
    update({ sessionUpdate: "tool_call", ...edit, status: "pending", content: [diff] });
    lines.push({
      type: "emit_inbound",
      frame: {
        kind: "request",
        method: "session/request_permission",
        params: {
          sessionId: "dev-replay-session",
          toolCall: edit,
          options: [
            { optionId: "allow-once", name: "Yes", kind: "allow_once" },
            { optionId: "reject-once", name: "No", kind: "reject_once" },
          ],
        },
      },
    });
    lines.push({
      type: "expect_outbound",
      frame: { kind: "response", method: "session/request_permission", result: "<any>" },
    });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "edit",
      status: "completed",
      content: [diff],
    });
    update(plan(2));
    update({
      sessionUpdate: "tool_call",
      toolCallId: "test",
      kind: "execute",
      title: "vp test run",
      status: "in_progress",
      rawInput: { command: "vp test run" },
    });
    update(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "test",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: text.terminal() } }],
      },
      1200,
    );
    update(plan(3));
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: text.reply() } });
    lines.push({
      type: "emit_inbound",
      frame: { kind: "response", method: "session/prompt", result: { stopReason: "end_turn" } },
    });
  }
  return lines.map((line) => JSON.stringify(line)).join("\n");
}
