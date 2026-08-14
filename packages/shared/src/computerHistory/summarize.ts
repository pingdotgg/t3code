// @effect-diagnostics globalDate:off
import type { ComputerHistoryEvent } from "./events.ts";

export type MemoryLevel = "10min" | "6h";

export type SummarizeInput = {
  readonly level: MemoryLevel;
  readonly startedAt: Date;
  readonly events: ReadonlyArray<ComputerHistoryEvent>;
  /** For 6h rollups: already-rendered child markdown bodies. */
  readonly childBodies?: ReadonlyArray<string>;
};

export type SummarizeResult = {
  readonly title: string;
  readonly description: string;
  readonly applications: ReadonlyArray<string>;
  readonly body: string;
  readonly suggestion?: {
    readonly type: "skill" | "automation";
    readonly name: string;
    readonly description: string;
  };
};

function formatClock(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function collectApplications(events: ReadonlyArray<ComputerHistoryEvent>): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    const id = event.app?.bundleIdentifier ?? event.app?.name;
    if (id) seen.add(id);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function eventLabel(event: ComputerHistoryEvent): string {
  const app = event.app?.name ?? event.app?.bundleIdentifier ?? "Unknown app";
  const window = event.window?.title ? ` — ${event.window.title}` : "";
  const ax =
    event.ax?.description || event.ax?.value
      ? ` (${[event.ax.description, event.ax.value].filter(Boolean).join(": ")})`
      : "";
  const text = event.text ? ` text=${JSON.stringify(event.text.slice(0, 80))}` : "";
  const url = event.url ? ` url=${event.url}` : "";
  return `${event.kind}: ${app}${window}${ax}${text}${url}`;
}
export function summarizeComputerHistory(input: SummarizeInput): SummarizeResult {
  const applications = collectApplications(input.events);
  const appList = applications.length > 0 ? applications.join(", ") : "no identified apps";

  const focusEvents = input.events.filter(
    (event) =>
      event.kind === "appWindowChanged" ||
      event.kind === "ax.focus_changed" ||
      event.kind === "sample.frontmost",
  );
  const distinctWindows = [
    ...new Set(
      focusEvents
        .map((event) => event.window?.title?.trim())
        .filter((title): title is string => Boolean(title)),
    ),
  ].slice(0, 12);

  const title =
    distinctWindows[0]?.slice(0, 72) ||
    (applications[0] ? `Activity in ${applications[0]}` : "Desktop activity");

  const description =
    input.level === "10min"
      ? `You spent this window primarily across ${appList}. ` +
        (distinctWindows.length > 0
          ? `Notable surfaces included ${distinctWindows.slice(0, 3).join("; ")}.`
          : "No window titles were captured.")
      : `Over this longer arc you worked across ${appList}. ` +
        `${input.childBodies?.length ?? 0} shorter summaries were rolled up.`;

  const recordingLines =
    input.level === "6h" && input.childBodies && input.childBodies.length > 0
      ? input.childBodies.map((body, index) => `### Child ${index + 1}\n\n${body}`)
      : input.events.slice(0, 80).map((event) => `- ${event.timestamp}: ${eventLabel(event)}`);

  const body = `## Memory summary

The user was active on their desktop during this ${input.level} window starting ${formatClock(input.startedAt)}. Observed applications: ${appList}.

### Relevant prior context

No prior Computer History context was attached to this summarization pass.

### Important non-obvious context about the user

${
  distinctWindows.length > 0
    ? distinctWindows.map((window) => `- Window/title observed: ${window}`).join("\n")
    : "- No durable non-obvious context was established in this window."
}

## Recording summary

${recordingLines.join("\n\n")}

## Citations

- Local Computer History segment events summarized at ${formatClock(new Date())}
`;

  // Suggest a skill when the same app appears often with repeated window patterns.
  let suggestion: SummarizeResult["suggestion"];
  if (input.level === "10min" && applications.length === 1 && distinctWindows.length >= 3) {
    suggestion = {
      type: "skill",
      name: `${applications[0]} workflow`,
      description: `Turn my recent ${applications[0]} activity into a reusable skill I can invoke later.`,
    };
  }

  return {
    title,
    description,
    applications,
    body,
    ...(suggestion ? { suggestion } : {}),
  };
}

export function renderMemoryMarkdown(
  result: SummarizeResult,
  level: MemoryLevel,
  startedAt: Date,
  idSuffix: string,
): { readonly filename: string; readonly contents: string } {
  const stamp = startedAt
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replaceAll(":", "-");
  const slug = result.title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 48);
  const filename = `${stamp}-${idSuffix}-${level}-${slug || "activity"}.md`;

  const appsYaml =
    result.applications.length === 0
      ? "[]"
      : `[${result.applications.map((app) => JSON.stringify(app)).join(", ")}]`;

  const suggestionYaml = result.suggestion
    ? `\nsuggestion:\n  type: ${result.suggestion.type}\n  name: ${JSON.stringify(result.suggestion.name)}\n  description: ${JSON.stringify(result.suggestion.description)}`
    : "";

  const contents = `---
title: ${JSON.stringify(result.title)}
description: ${JSON.stringify(result.description)}
applications: ${appsYaml}${suggestionYaml}
---

${result.body}
`;

  return { filename, contents };
}

export const SKYSIGHT_INSTRUCTIONS = `# Computer History Memory Instructions

Computer History provides chronological 10-minute and 6-hour summaries of the user's recent desktop activity from a local interaction-event stream.

When generating memories or answering questions about recent work, use relevant summaries from the resources folder next to this instructions file as evidence. Grep the folder for material relevant to the task.

The YAML frontmatter in each resource is presentation metadata. Ignore it during consolidation and use the Markdown body as evidence.

Tag derived facts with \`[computer history memory]\` (Codex mirror: \`[skysight memory]\`).
`;
