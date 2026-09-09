import type { ThreadTitleMessage } from "./ThreadTitleContext.ts";

// Public PR subjects and existing title scenarios. Repeated text adds context pressure.
export const threadTitleEvaluationCases = [
  {
    id: "linked-reset-credits",
    source: "https://github.com/pingdotgg/t3code/pull/10462",
    request: "Review the reset credit routing change.",
    previousTitle: "Review PR 10462",
    messages: [{ role: "user", text: "Review https://github.com/pingdotgg/t3code/pull/10462" }],
    rubric: "Name reset credit routing. Distinguish it from displaying credit balances.",
  },
  {
    id: "onboarding-merge",
    source: "https://github.com/pingdotgg/t3code/pull/10465",
    request: "Make onboarding one shared wizard across computers, then merge when green.",
    previousTitle: "Finish onboarding PR",
    messages: [
      { role: "user", text: "Make onboarding one shared wizard across computers." },
      {
        role: "assistant",
        text: "The wizard now handles pairing, agent selection, and project import.",
      },
      { role: "user", text: "File a PR and merge it when green." },
    ],
    rubric: "Keep the multi-computer onboarding subject. Do not title it after merging.",
  },
  {
    id: "vague-opening",
    source: "Existing lazy thread feed title scenario",
    request: "A failing test is later identified as a lazy thread feed mismatch.",
    previousTitle: "Fix failing test",
    messages: [
      { role: "user", text: "Fix this failing test." },
      {
        role: "assistant",
        text: "The lazy thread feed test expects a full message body before the client requests it.",
      },
    ],
    rubric: "Name the lazy thread feed test. Do not invent a wider mobile regression.",
  },
  {
    id: "scope-change",
    source: "Title context budget scenario",
    request: "Change the goal from QR layout to pairing expiry, despite long assistant replies.",
    previousTitle: "Improve QR layout",
    messages: [
      { role: "user", text: "Improve QR sharing layout." },
      {
        role: "user",
        text: "Change of plan. Fix pairing token expiry. Keep remote access working.",
      },
      {
        role: "assistant",
        text: "The token expires before redemption. " + "Implementation detail. ".repeat(800),
      },
      { role: "user", text: "Ship it." },
    ],
    rubric: "Name pairing expiry and honor the explicit scope change.",
  },
  {
    id: "review-umbrella",
    source: "Existing subagent monitoring title scenario",
    request: "Review subagent monitoring risks. A Codex roster issue is one finding.",
    previousTitle: "Review subagent monitoring risks",
    messages: [
      { role: "user", text: "Review subagent monitoring risks." },
      {
        role: "assistant",
        text: "One finding is a stale Codex roster. " + "Roster detail. ".repeat(800),
      },
      { role: "user", text: "Fix the findings and babysit CI." },
    ],
    rubric: "Preserve the monitoring review scope. The previous title can stay unchanged.",
  },
  {
    id: "long-opening",
    source: "Title message truncation scenario",
    request: "Investigate Android pairing while preserving the iOS flow.",
    previousTitle: "Inspect logs",
    messages: [
      {
        role: "user",
        text:
          "Investigate Android pairing. " +
          "Connection logs. ".repeat(800) +
          " Preserve the iOS pairing flow.",
      },
    ],
    rubric: "Name Android pairing. Logs are supporting evidence.",
  },
  {
    id: "research",
    source: "Maintainer title generation request",
    request: "How can we improve title generation in T3 Code?",
    previousTitle: "Research title gen improvements",
    messages: [
      { role: "user", text: "How can we improve title gen further in T3 Code?" },
      {
        role: "assistant",
        text: "Prioritize user messages, refine vague titles once, and resolve PR subjects.",
      },
      {
        role: "user",
        text: "Make these changes and file a PR. Babysit until everything is green.",
      },
    ],
    rubric: "Keep title generation as the subject. Do not focus on filing the PR.",
  },
] satisfies ReadonlyArray<{
  id: string;
  source: string;
  request: string;
  previousTitle: string;
  messages: ReadonlyArray<ThreadTitleMessage>;
  rubric: string;
}>;
