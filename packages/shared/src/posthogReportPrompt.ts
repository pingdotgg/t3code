/**
 * Renders a PostHog self-driving report and its artefacts as the context the
 * agent reads before the user's first message. Pure: the same report always
 * yields the same markdown, so the prompt can be reviewed before it is sent.
 */
import {
  PostHogActionabilityAssessment,
  PostHogCodeReference,
  PostHogPriorityAssessment,
  PostHogRepoSelection,
  PostHogSignalFinding,
  PostHogSuggestedReviewers,
  postHogReportUrl,
  type PostHogReport,
  type PostHogReportArtefact,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface RenderReportPromptOptions {
  readonly host: string;
  readonly projectId: string;
}

const decodeFinding = Schema.decodeUnknownOption(PostHogSignalFinding);
const decodePriority = Schema.decodeUnknownOption(PostHogPriorityAssessment);
const decodeActionability = Schema.decodeUnknownOption(PostHogActionabilityAssessment);
const decodeCodeReference = Schema.decodeUnknownOption(PostHogCodeReference);
const decodeReviewers = Schema.decodeUnknownOption(PostHogSuggestedReviewers);
const decodeRepoSelection = Schema.decodeUnknownOption(PostHogRepoSelection);

function decodeAll<A>(
  artefacts: ReadonlyArray<PostHogReportArtefact>,
  type: string,
  decode: (content: unknown) => Option.Option<A>,
): ReadonlyArray<A> {
  return artefacts
    .filter((artefact) => artefact.type === type)
    .flatMap((artefact) => Option.toArray(decode(artefact.content)));
}

// Status artefacts are latest-wins on the PostHog side; the API lists newest first.
function decodeLatest<A>(
  artefacts: ReadonlyArray<PostHogReportArtefact>,
  type: string,
  decode: (content: unknown) => Option.Option<A>,
): A | null {
  return decodeAll(artefacts, type, decode)[0] ?? null;
}

const fenceFor = (contents: string): string => {
  let fence = "```";
  while (contents.includes(fence)) fence += "`";
  return fence;
};

const formatDollarValue = (value: number): string =>
  `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function renderReportPrompt(
  report: PostHogReport,
  artefacts: ReadonlyArray<PostHogReportArtefact>,
  options: RenderReportPromptOptions,
): string {
  const lines: Array<string> = [];
  const push = (...items: ReadonlyArray<string>) => lines.push(...items);

  push(`# ${report.title}`, "");
  const summary = report.summary?.trim() ?? "";
  if (summary.length > 0) {
    push(summary, "");
  }

  const priority = decodeLatest(artefacts, "priority_judgment", decodePriority);
  const actionability = decodeLatest(artefacts, "actionability_judgment", decodeActionability);
  if (priority || actionability) {
    push("## Assessment", "");
    if (priority) {
      const value =
        priority.dollar_value !== undefined && priority.dollar_value !== null
          ? ` (estimated value ${formatDollarValue(priority.dollar_value)})`
          : "";
      push(`- Priority: ${priority.priority}${value}`);
      if (priority.explanation.trim().length > 0) push(`  - ${priority.explanation.trim()}`);
    }
    if (actionability) {
      push(
        `- Actionability: ${actionability.actionability}${actionability.already_addressed ? " (already addressed elsewhere)" : ""}`,
      );
      if (actionability.explanation.trim().length > 0) {
        push(`  - ${actionability.explanation.trim()}`);
      }
    }
    push("");
  }

  const findings = decodeAll(artefacts, "signal_finding", decodeFinding);
  if (findings.length > 0) {
    push("## Findings", "");
    findings.forEach((finding, index) => {
      push(`### Finding ${index + 1} (signal ${finding.signal_id})`, "");
      push(`- Verified: ${finding.verified ? "yes" : "no"}`);
      if (finding.relevant_code_paths.length > 0) {
        push("- Code paths:");
        for (const codePath of finding.relevant_code_paths) push(`  - \`${codePath}\``);
      }
      const commits = Object.entries(finding.relevant_commit_hashes);
      if (commits.length > 0) {
        push("- Commits:");
        for (const [hash, note] of commits) push(`  - \`${hash}\`: ${note}`);
      }
      if (finding.data_queried.trim().length > 0) {
        push(`- Data queried: ${finding.data_queried.trim()}`);
      }
      push("");
    });
  }

  const codeReferences = decodeAll(artefacts, "code_reference", decodeCodeReference);
  if (codeReferences.length > 0) {
    push("## Code references", "");
    for (const reference of codeReferences) {
      push(
        `### \`${reference.file_path}\` lines ${reference.start_line}-${reference.end_line}`,
        "",
      );
      if (reference.relevance_note.trim().length > 0) push(reference.relevance_note.trim(), "");
      const fence = fenceFor(reference.contents);
      push(fence, reference.contents, fence, "");
    }
  }

  const reviewers = decodeLatest(artefacts, "suggested_reviewers", decodeReviewers) ?? [];
  if (reviewers.length > 0) {
    push("## Suggested reviewers", "");
    for (const reviewer of reviewers) {
      const name = reviewer.github_name ? ` (${reviewer.github_name})` : "";
      const reason = reviewer.reason ? `: ${reviewer.reason}` : "";
      push(`- @${reviewer.github_login}${name}${reason}`);
    }
    push("");
  }

  const repoSelection = decodeLatest(artefacts, "repo_selection", decodeRepoSelection);
  if (repoSelection?.repository) {
    push("## Repository", "", `\`${repoSelection.repository}\``);
    if (repoSelection.reason.trim().length > 0) push("", repoSelection.reason.trim());
    push("");
  }

  const reportUrl = postHogReportUrl({
    host: options.host,
    projectId: options.projectId,
    reportId: report.id,
  });
  push("## Instructions", "");
  push(
    "This conversation is about the PostHog self-driving report above. The user will say what they want.",
    "If you make code changes, commit them on the current branch and open a pull request whose body links the report:",
    reportUrl,
    "",
  );
  return lines.join("\n");
}
