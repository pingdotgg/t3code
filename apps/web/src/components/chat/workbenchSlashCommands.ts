/**
 * Workbench-owned slash commands — backend-agnostic shortcuts that expand to
 * structured prompt templates at composition time. Selecting one replaces
 * the user's `/name` typing with the `prompt` text below and places the
 * cursor at the end so they can keep typing details.
 *
 * These are intentionally written to:
 *  - work against whatever context the user has (folder/file mentions or
 *    plain text) without requiring a specific tool capability;
 *  - invite the assistant to ask a short clarifying question when critical
 *    details are missing, so knowledge workers don't have to front-load
 *    everything into a single prompt;
 *  - ask for permission before destructive actions (see `organize`);
 *  - stay narrow in scope so they compose cleanly with `@file` mentions and
 *    with built-in commands like `/plan`.
 *
 * When adding a new command, keep it under ~3 short sentences — anything
 * longer belongs in a skill (which we'll formalize in a later slice).
 */
export interface WorkbenchSlashCommand {
  /** Bare slug, without leading slash. Used as the item id. */
  readonly command: string;
  /** Menu label, typically `/${command}`. */
  readonly label: string;
  /** One-line description shown in the menu. */
  readonly description: string;
  /** Full prompt template inserted when the user picks this command. */
  readonly prompt: string;
}

export const WORKBENCH_SLASH_COMMANDS: ReadonlyArray<WorkbenchSlashCommand> = [
  {
    command: "summarize",
    label: "/summarize",
    description: "Summarize the current folder or a specific file",
    prompt:
      "Summarize the current context. If I've mentioned a specific file or folder, focus on that. Otherwise, take a look at the folder I'm working in, describe what's here, and flag anything notable. Ask me a follow-up question if you need more to go on: ",
  },
  {
    command: "research",
    label: "/research",
    description: "Research a topic and produce a briefing with sources",
    prompt:
      "Research the following topic and produce a short briefing with sources. Use whatever web or file-search tools are available to you — if no web tool is available, say so up front so I can point you at files or URLs instead. Ask a scoping question if the topic is ambiguous. Topic: ",
  },
  {
    command: "draft",
    label: "/draft",
    description: "Draft a document — email, memo, report, etc.",
    prompt:
      "Draft the following. Use any files I've mentioned as source material. If the document type, audience, or tone isn't clear, ask me one or two short questions before you write. Draft type and details: ",
  },
  {
    command: "rewrite",
    label: "/rewrite",
    description: "Rewrite text to be clearer and more concise",
    prompt:
      "Rewrite the following to be clearer and more concise while preserving the meaning and key facts. If the intended audience or tone isn't obvious from context, ask before rewriting. Text to rewrite: ",
  },
  {
    command: "organize",
    label: "/organize",
    description: "Suggest a structure for the current folder (asks before moving files)",
    prompt:
      "Review the current folder and suggest an organized structure. Before renaming or moving anything, explain the plan you'd like to carry out and ask me for permission. Pay attention to existing naming patterns and date-ordered files.",
  },
  {
    command: "compare",
    label: "/compare",
    description: "Compare docs, options, plans, or versions side by side",
    prompt:
      "Compare the following side by side. Produce a structured comparison (a table if the items share clear axes, otherwise a bulleted list of differences) and call out what's different, what's the same, and which one fits best for which situation. Ask about the comparison criteria if they aren't clear. Items to compare: ",
  },
  {
    command: "nextsteps",
    label: "/nextsteps",
    description: "Interview-style help thinking through what to do next",
    prompt:
      "Help me think through what to do next. Before giving advice, ask me 2–4 short clarifying questions about my goal, constraints, and timeline. Then lay out 3–5 concrete next actions with the reasoning behind each, in priority order. Starting context: ",
  },
];
