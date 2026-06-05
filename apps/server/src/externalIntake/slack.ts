function envValue(name: string) {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export function slackExternalThreadId(input: {
  readonly channelId: string;
  readonly threadTs: string;
  readonly teamId?: string | undefined;
}) {
  return input.teamId === undefined
    ? `${input.channelId}:${input.threadTs}`
    : `${input.teamId}:${input.channelId}:${input.threadTs}`;
}

export function parseSlackExternalThreadId(externalThreadId: string) {
  const parts = externalThreadId.split(":");
  const threadTs = parts.at(-1);
  const channelId = parts.at(-2);
  if (channelId === undefined || threadTs === undefined) {
    throw new Error(`Invalid Slack external thread id: ${externalThreadId}`);
  }
  return { channelId, threadTs };
}

export function slackThreadUrl(input: { readonly channelId: string; readonly threadTs: string }) {
  const workspace = envValue("SLACK_WORKSPACE_URL")?.replace(/\/$/, "");
  if (workspace === undefined) return undefined;
  return `${workspace}/archives/${input.channelId}/p${input.threadTs.replace(".", "")}`;
}

export function stripSlackClientAttribution(text: string) {
  return text.replace(/\n?\s*(?:\*Sent using\*|_Sent using_|Sent using)\s+ChatGPT\s*$/i, "").trim();
}

export function t3ThreadUrl(input: {
  readonly baseUrl?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly t3ThreadId?: string | undefined;
}) {
  const baseUrl = input.baseUrl?.trim().replace(/\/$/, "");
  if (!baseUrl || !input.environmentId || !input.t3ThreadId) return undefined;
  return `${baseUrl}/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.t3ThreadId)}`;
}
