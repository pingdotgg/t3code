import type { PostHogReport, PostHogReportArtefact } from "@t3tools/contracts";
import { PostHogReportId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { renderReportPrompt } from "./posthogReportPrompt.ts";

const report: PostHogReport = {
  id: PostHogReportId.make("0f3c2a1e-7b6d-4c2a-9e1f-1234567890ab"),
  title: "Checkout button unresponsive on Safari",
  summary: "Users on Safari 17 report the pay button does nothing after the first click.",
  status: "ready",
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-02T12:00:00Z",
  priority: "P1",
  actionability: "immediately_actionable",
};

const artefact = (type: string, content: unknown, index: number): PostHogReportArtefact => ({
  id: `artefact-${index}`,
  type,
  content,
  created_at: `2026-08-02T12:0${index}:00Z`,
});

const artefacts: ReadonlyArray<PostHogReportArtefact> = [
  artefact(
    "priority_judgment",
    {
      priority: "P1",
      explanation: "Blocks purchases on a supported browser.",
      dollar_value: 12000,
    },
    1,
  ),
  artefact(
    "actionability_judgment",
    { actionability: "immediately_actionable", explanation: "Handler is a one-line fix." },
    2,
  ),
  artefact(
    "signal_finding",
    {
      signal_id: "sig_checkout_safari",
      relevant_code_paths: ["web/src/checkout/PayButton.tsx"],
      relevant_commit_hashes: { abc1234: "Added double-submit guard" },
      data_queried: "Session replays filtered by browser = Safari",
      verified: true,
    },
    3,
  ),
  artefact(
    "code_reference",
    {
      file_path: "web/src/checkout/PayButton.tsx",
      start_line: 40,
      end_line: 42,
      contents: "if (submitting) return;\nsetSubmitting(true);",
      relevance_note: "The guard never resets on Safari because the promise rejects silently.",
    },
    4,
  ),
  artefact("suggested_reviewers", [{ github_login: "octocat", reason: "Owns checkout" }], 5),
  artefact("repo_selection", { repository: "example/shop", reason: "Only web repo." }, 6),
  artefact("note", { note: "Unrelated log entry" }, 7),
];

describe("renderReportPrompt", () => {
  it("renders every artefact section and the report link", () => {
    const prompt = renderReportPrompt(report, artefacts, {
      host: "https://us.posthog.com/",
      projectId: "42",
    });

    expect(prompt).toMatchInlineSnapshot(`
      "# Checkout button unresponsive on Safari

      Users on Safari 17 report the pay button does nothing after the first click.

      ## Assessment

      - Priority: P1 (estimated value $12,000)
        - Blocks purchases on a supported browser.
      - Actionability: immediately_actionable
        - Handler is a one-line fix.

      ## Findings

      ### Finding 1 (signal sig_checkout_safari)

      - Verified: yes
      - Code paths:
        - \`web/src/checkout/PayButton.tsx\`
      - Commits:
        - \`abc1234\`: Added double-submit guard
      - Data queried: Session replays filtered by browser = Safari

      ## Code references

      ### \`web/src/checkout/PayButton.tsx\` lines 40-42

      The guard never resets on Safari because the promise rejects silently.

      \`\`\`
      if (submitting) return;
      setSubmitting(true);
      \`\`\`

      ## Suggested reviewers

      - @octocat: Owns checkout

      ## Repository

      \`example/shop\`

      Only web repo.

      ## Instructions

      This conversation is about the PostHog self-driving report above. The user will say what they want.
      If you make code changes, commit them on the current branch and open a pull request whose body links the report:
      https://us.posthog.com/project/42/inbox/reports/0f3c2a1e-7b6d-4c2a-9e1f-1234567890ab
      "
    `);
  });
});
