import type { Adapter } from "chat";
import { createLinearAdapter, type LinearAdapterConfig } from "@chat-adapter/linear";
import { createSlackAdapter, type SlackAdapterConfig } from "@chat-adapter/slack";

function envValue(name: string) {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function linearAdapterConfig(): LinearAdapterConfig {
  const clientId = envValue("LINEAR_CLIENT_CREDENTIALS_CLIENT_ID") ?? envValue("LINEAR_CLIENT_ID");
  const clientSecret =
    envValue("LINEAR_CLIENT_CREDENTIALS_CLIENT_SECRET") ?? envValue("LINEAR_CLIENT_SECRET");
  const webhookSecret = envValue("LINEAR_WEBHOOK_SECRET");
  const userName = envValue("LINEAR_BOT_USERNAME");

  if (clientId !== undefined && clientSecret !== undefined) {
    return {
      clientCredentials: {
        clientId,
        clientSecret,
        scopes: ["read", "write", "comments:create", "app:mentionable"],
      },
      ...(webhookSecret !== undefined ? { webhookSecret } : {}),
      ...(userName !== undefined ? { userName } : {}),
    };
  }

  return {
    ...(webhookSecret !== undefined ? { webhookSecret } : {}),
    ...(userName !== undefined ? { userName } : {}),
  };
}

function slackAdapterConfig(): SlackAdapterConfig {
  const botToken = envValue("SLACK_BOT_TOKEN");
  const signingSecret = envValue("SLACK_SIGNING_SECRET");
  const botUserId = envValue("SLACK_BOT_USER_ID");
  const userName = envValue("SLACK_BOT_USERNAME");

  return {
    ...(botToken !== undefined ? { botToken } : {}),
    ...(signingSecret !== undefined ? { signingSecret } : {}),
    ...(botUserId !== undefined ? { botUserId } : {}),
    ...(userName !== undefined ? { userName } : {}),
  };
}

function createChatCompatibleSlackAdapter(config: SlackAdapterConfig): Adapter {
  const adapter = createSlackAdapter(config);
  // The Slack adapter's runtime shape satisfies Chat's adapter interface, but its
  // botUserId getter is typed as string | undefined under exactOptionalPropertyTypes.
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === "botUserId") {
        return target.botUserId ?? "";
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Adapter;
}

export function chatUserName() {
  return envValue("LINEAR_BOT_USERNAME") ?? envValue("SLACK_BOT_USERNAME") ?? "engineering";
}

export type TaskIntakeChatSdkSource = "linear" | "slack";

export function createTaskIntakeChatSdkAdapters(input?: {
  readonly sources?: ReadonlySet<TaskIntakeChatSdkSource>;
}) {
  const sources = input?.sources ?? new Set<TaskIntakeChatSdkSource>(["linear", "slack"]);
  return {
    ...(sources.has("linear") ? { linear: createLinearAdapter(linearAdapterConfig()) } : {}),
    ...(sources.has("slack")
      ? { slack: createChatCompatibleSlackAdapter(slackAdapterConfig()) }
      : {}),
  };
}
