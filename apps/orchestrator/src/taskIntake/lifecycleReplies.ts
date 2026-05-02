export function chatSdkThreadIdForLifecycleReply(input: {
  readonly kind: "linear_issue" | "slack_thread";
  readonly externalId: string;
}) {
  if (input.kind === "linear_issue") {
    return `linear:${input.externalId}`;
  }

  const parts = input.externalId.split(":");
  const channelId = parts.at(-2);
  const threadTs = parts.at(-1);
  if (!channelId || !threadTs) {
    throw new Error(`Invalid Slack thread external id: ${input.externalId}`);
  }
  return `slack:${channelId}:${threadTs}`;
}
