export function buildLinearExecutionPrompt(input: {
  readonly authorName?: string;
  readonly body: string;
  readonly commentUrl?: string;
  readonly issueId: string;
  readonly linearThreadKey: string;
  readonly messageId?: string;
}) {
  const authorLabel = input.authorName?.trim() || "Unknown author";
  const trimmedBody = input.body.trim();

  return [
    "A Linear comment thread triggered this run.",
    "",
    `Issue ID: ${input.issueId}`,
    `Linear thread: ${input.linearThreadKey}`,
    ...(input.messageId !== undefined ? [`Trigger comment ID: ${input.messageId}`] : []),
    `Author: ${authorLabel}`,
    ...(input.commentUrl !== undefined ? [`Comment URL: ${input.commentUrl}`] : []),
    "",
    "User request:",
    trimmedBody.length > 0 ? trimmedBody : "(empty comment body)",
    "",
    "MVP note:",
    "- This integration currently receives comment text and markdown links only.",
    "- If the user referenced an attachment, treat it as unavailable unless the link is present in the comment body.",
    "- Leave a concise final summary inside the T3 thread because Linear currently receives lifecycle status only.",
  ].join("\n");
}

export function buildLinearLifecycleReply(input: {
  readonly executionRunId: string;
  readonly failureSummary?: string;
  readonly status: "completed" | "failed";
  readonly t3ThreadId?: string;
}) {
  if (input.status === "completed") {
    return [
      "T3 finished this run.",
      "",
      `- Execution run: \`${input.executionRunId}\``,
      ...(input.t3ThreadId !== undefined ? [`- Worker thread: \`${input.t3ThreadId}\``] : []),
      "- Current MVP note: detailed output still lives in T3; this reply confirms the run completed.",
    ].join("\n");
  }

  return [
    "T3 could not finish this run.",
    "",
    `- Execution run: \`${input.executionRunId}\``,
    ...(input.t3ThreadId !== undefined ? [`- Worker thread: \`${input.t3ThreadId}\``] : []),
    `- Failure summary: ${input.failureSummary?.trim() || "Unknown error"}`,
  ].join("\n");
}
