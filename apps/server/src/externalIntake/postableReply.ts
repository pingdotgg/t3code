import type { UserInputQuestion } from "@t3tools/contracts";
import { Actions, Card, CardText, LinkButton, type PostableMessage } from "chat";

export type ReplyLinkKind = "slack_thread";

export interface TaskStartedStatusMessage {
  readonly kind: ReplyLinkKind;
  readonly t3ThreadUrl?: string | undefined;
}

export interface PullRequestMergedMessage {
  readonly kind: ReplyLinkKind;
  readonly pullRequestUrl: string;
  readonly title?: string | undefined;
}

export interface SupportEmailNotificationMessage {
  readonly kind: ReplyLinkKind;
  readonly title: string;
  readonly preview: string;
  readonly status?: string | undefined;
  readonly t3ThreadUrl?: string | undefined;
}

export interface UserInputRequestMessage {
  readonly kind: ReplyLinkKind;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitMarkdownTableRow(line: string): ReadonlyArray<string> {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function stripOuterBold(value: string) {
  return value.replace(/^\*\*(.*)\*\*$/s, "$1");
}

function markdownTableToSlackBullets(lines: ReadonlyArray<string>): string {
  const header = splitMarkdownTableRow(lines[0] ?? "");
  const rows = lines.slice(2).map(splitMarkdownTableRow);

  return rows
    .map((row) => {
      const title = stripOuterBold(row[0]?.trim() ?? "");
      const details = row
        .slice(1)
        .map((cell, index) => {
          const label = header[index + 1]?.trim();
          return label && cell ? `**${label}:** ${cell}` : cell;
        })
        .filter((cell) => cell.length > 0)
        .join("; ");

      if (!title) {
        return details ? `- ${details}` : "";
      }
      return details ? `- **${title}:** ${details}` : `- **${title}**`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

export function flattenMarkdownTablesForSlack(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";
    if (line.includes("|") && isMarkdownTableSeparator(nextLine)) {
      const tableLines = [line, nextLine];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      index -= 1;
      output.push(markdownTableToSlackBullets(tableLines));
      continue;
    }

    output.push(line);
  }

  return output.join("\n");
}

export function protectSlackPackageScopes(markdown: string): string {
  return markdown.replace(/(^|[^\w<`])@([a-z][a-z0-9._-]*\/[a-z0-9._*/-]+)/gi, "$1`@$2`");
}

export function toSlackMarkdown(markdown: string): string {
  return protectSlackPackageScopes(flattenMarkdownTablesForSlack(markdown));
}

export function postableReplyBody(input: {
  readonly kind: ReplyLinkKind;
  readonly body: string;
}): PostableMessage {
  return { markdown: toSlackMarkdown(input.body) };
}

function formatUserInputQuestion(question: UserInputQuestion, index: number) {
  const title = question.header.trim() || `Question ${index + 1}`;
  const lines = [`${index + 1}. **${title}**`, question.question.trim()];
  if (question.options.length > 0) {
    lines.push(
      "",
      "Options:",
      ...question.options.map((option, optionIndex) => {
        const description = option.description.trim();
        return `${optionIndex + 1}. ${option.label}${description ? ` - ${description}` : ""}`;
      }),
    );
  }
  return lines.join("\n");
}

export function postableUserInputRequest(input: UserInputRequestMessage): PostableMessage {
  const answerHint =
    input.questions.length === 1
      ? "Reply in this thread with the answer."
      : "Reply in this thread with numbered answers, one per line.";
  const markdown = [
    "Claude needs input to continue.",
    "",
    ...input.questions.map(formatUserInputQuestion),
    "",
    answerHint,
  ].join("\n");

  return { markdown: toSlackMarkdown(markdown) };
}

export function postableTaskStartedStatus(input: TaskStartedStatusMessage): PostableMessage {
  const body = [
    "Talk to Vevin in this thread.",
    ...(input.t3ThreadUrl !== undefined ? [`Open T3: ${input.t3ThreadUrl}`] : []),
  ].join("\n");

  return {
    card: Card({
      title: "Talk to Vevin in this thread",
      children: [
        CardText("I will keep replies here and link the T3 session once it is available."),
        ...(input.t3ThreadUrl !== undefined
          ? [
              Actions([
                LinkButton({
                  label: "Open T3",
                  url: input.t3ThreadUrl,
                  style: "primary",
                }),
              ]),
            ]
          : []),
      ],
    }),
    fallbackText: body,
  };
}

export function postableSupportEmailNotification(
  input: SupportEmailNotificationMessage,
): PostableMessage {
  const body = [
    input.title,
    "",
    input.preview,
    ...(input.status !== undefined ? ["", input.status] : []),
    ...(input.t3ThreadUrl !== undefined ? ["", `Open T3: ${input.t3ThreadUrl}`] : []),
  ].join("\n");

  return {
    card: Card({
      title: input.title,
      children: [
        CardText(`\`\`\`\n${input.preview}\n\`\`\``),
        ...(input.status !== undefined ? [CardText(input.status)] : []),
        ...(input.t3ThreadUrl !== undefined
          ? [
              Actions([
                LinkButton({
                  label: "Open T3",
                  url: input.t3ThreadUrl,
                  style: "primary",
                }),
              ]),
            ]
          : []),
      ],
    }),
    fallbackText: body,
  };
}

function pullRequestNumberFromUrl(url: string): string | null {
  return /\/pull\/(\d+)(?:$|[/?#])/i.exec(url)?.[1] ?? null;
}

function escapeMarkdownLinkLabel(label: string) {
  return label
    .replace(/([\\[\]])/g, "\\$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function postablePullRequestMerged(input: PullRequestMergedMessage): PostableMessage {
  const number = pullRequestNumberFromUrl(input.pullRequestUrl);
  const title = input.title?.trim();
  const label = `${number !== null ? `PR #${number}` : "PR"}${title ? `: ${title}` : ""}`;
  const markdown = `Merged noted. [${escapeMarkdownLinkLabel(label)}](${input.pullRequestUrl}) is done.`;

  return {
    markdown: toSlackMarkdown(markdown),
  };
}
