import { Actions, Card, CardText, Field, Fields, LinkButton, type PostableMessage } from "chat";

export type ReplyLinkKind = "linear_issue" | "slack_thread";

export interface TaskStartedStatusMessage {
  readonly kind: ReplyLinkKind;
  readonly t3ThreadUrl?: string | undefined;
}

export interface PullRequestStatusMessage {
  readonly kind: ReplyLinkKind;
  readonly body: string;
  readonly pullRequestUrl: string;
  readonly pullRequestStatus?: "created" | "existing" | undefined;
  readonly title?: string | undefined;
  readonly repo?: string | undefined;
  readonly branch?: string | undefined;
  readonly t3ThreadUrl?: string | undefined;
  readonly previewUrl?: string | undefined;
  readonly deploymentPreviews?:
    | ReadonlyArray<{
        readonly environment?: string | undefined;
        readonly url: string;
      }>
    | undefined;
}

export interface DeploymentReadyMessage {
  readonly kind: ReplyLinkKind;
  readonly environment?: string | undefined;
  readonly url: string;
}

export interface OpsHealthAlertMessage {
  readonly title: string;
  readonly summary: string;
  readonly status: "failing" | "recovered";
  readonly checkedAt: string;
  readonly failingChecks: ReadonlyArray<{
    readonly name: string;
    readonly details: string;
  }>;
  readonly allChecks?: ReadonlyArray<{
    readonly name: string;
    readonly ok: boolean;
    readonly details: string;
  }>;
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
  return input.kind === "slack_thread" ? { markdown: toSlackMarkdown(input.body) } : input.body;
}

export function buildT3ThreadUrl(input: {
  readonly baseUrl?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly t3ThreadId?: string | undefined;
}): string | undefined {
  const baseUrl = input.baseUrl?.trim().replace(/\/$/, "");
  if (!baseUrl || !input.environmentId || !input.t3ThreadId) return undefined;
  return `${baseUrl}/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.t3ThreadId)}`;
}

export function postableTaskStartedStatus(input: TaskStartedStatusMessage): PostableMessage {
  const body = [
    "Talk to Vevin in this thread.",
    ...(input.t3ThreadUrl !== undefined ? [`Open T3: ${input.t3ThreadUrl}`] : []),
  ].join("\n");

  if (input.kind !== "slack_thread") {
    return body;
  }

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

function pullRequestNumberFromUrl(url: string): string | null {
  return /\/pull\/(\d+)(?:$|[/?#])/i.exec(url)?.[1] ?? null;
}

function previewLinks(input: PullRequestStatusMessage) {
  if (input.deploymentPreviews !== undefined && input.deploymentPreviews.length > 0) {
    return input.deploymentPreviews;
  }
  return input.previewUrl !== undefined ? [{ url: input.previewUrl }] : [];
}

function previewLabel(
  preview: { readonly environment?: string | undefined; readonly url: string },
  index: number,
) {
  const normalized = preview.environment
    ?.replace(/^Preview\s*(?:[-:]|\u2013|\u2014)\s*/i, "")
    .trim();
  if (normalized) return normalized.length > 24 ? `Preview ${index + 1}` : normalized;
  return index === 0 ? "Open Preview" : `Preview ${index + 1}`;
}

function chunks<T>(values: ReadonlyArray<T>, size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export function postablePullRequestStatus(input: PullRequestStatusMessage): PostableMessage {
  if (input.kind !== "slack_thread") {
    return input.body;
  }

  const number = pullRequestNumberFromUrl(input.pullRequestUrl);
  const title = input.title?.trim();
  const cardTitle = `New PR${number !== null ? ` #${number}` : ""}${title ? ` - ${title}` : ""}`;
  const previews = previewLinks(input);
  const actionButtons = [
    LinkButton({ label: "View PR", url: input.pullRequestUrl, style: "primary" as const }),
  ];
  const previewButtons = previews.map((preview, index) =>
    LinkButton({ label: previewLabel(preview, index), url: preview.url }),
  );

  const fields = [
    ...(input.repo !== undefined ? [Field({ label: "Repo", value: input.repo })] : []),
    ...(input.branch !== undefined ? [Field({ label: "Branch", value: input.branch })] : []),
    ...(input.pullRequestStatus !== undefined
      ? [Field({ label: "Status", value: input.pullRequestStatus })]
      : []),
  ];

  return {
    card: Card({
      title: cardTitle,
      children: [
        ...(fields.length > 0 ? [Fields(fields)] : []),
        Actions(actionButtons),
        ...chunks(previewButtons, 5).map((buttonGroup) => Actions(buttonGroup)),
      ],
    }),
    fallbackText: input.body,
  };
}

export function postableDeploymentReady(input: DeploymentReadyMessage): PostableMessage {
  const label = input.environment?.trim() || "Preview";
  const body = `Deployment ready (${label}): ${input.url}`;

  if (input.kind !== "slack_thread") {
    return body;
  }

  return {
    card: Card({
      title: `${label} is ready`,
      children: [
        Actions([
          LinkButton({
            label: "Open deployment",
            url: input.url,
            style: "primary",
          }),
        ]),
      ],
    }),
    fallbackText: body,
  };
}

export function postableOpsHealthAlert(input: OpsHealthAlertMessage): PostableMessage {
  const failingLines = input.failingChecks.map((check) => `- **${check.name}:** ${check.details}`);
  const body = [
    `**${input.title}**`,
    input.summary,
    `Checked: ${input.checkedAt}`,
    ...failingLines,
  ].join("\n");

  const fields = [
    Field({ label: "Status", value: input.status }),
    Field({ label: "Failing checks", value: String(input.failingChecks.length) }),
    Field({ label: "Checked", value: input.checkedAt }),
  ];
  const allChecks = input.allChecks ?? [];
  const passingCount = allChecks.filter((check) => check.ok).length;
  if (allChecks.length > 0) {
    fields.push(Field({ label: "Passing checks", value: `${passingCount}/${allChecks.length}` }));
  }

  const failureText =
    input.failingChecks.length === 0
      ? "No failing checks."
      : input.failingChecks.map((check) => `- **${check.name}:** ${check.details}`).join("\n");

  return {
    card: Card({
      title: input.title,
      children: [Fields(fields), CardText(failureText)],
    }),
    fallbackText: body,
  };
}
