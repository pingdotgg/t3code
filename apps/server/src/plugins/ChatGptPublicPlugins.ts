import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const CHATGPT_PUBLIC_MARKETPLACE_NAME = "ChatGPT Public";
export const CHATGPT_PUBLIC_MARKETPLACE_SOURCE = "chatgpt-public";
export const CHATGPT_BACKEND_API_URL = "https://chatgpt.com/backend-api";
export const CHATGPT_PUBLIC_PLUGIN_LIST_PAGE_LIMIT = 200;
export const CHATGPT_PUBLIC_PLUGIN_SEARCH_MAX_PAGES = 3;
export const CHATGPT_PUBLIC_PLUGIN_SEARCH_MIN_QUERY_LENGTH = 2;

export interface ChatGptPublicPlugin {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly developer: string;
  readonly category: string;
  readonly version: string;
  readonly logoUrl: string | null;
  readonly homepage: string | null;
  readonly appCount: number;
  readonly skillCount: number;
}

export interface CodexChatGptAuth {
  readonly accessToken: string;
  readonly accountId: string | null;
}

const ChatGptPublicPluginReleaseInterface = Schema.Struct({
  short_description: Schema.optional(Schema.String),
  long_description: Schema.optional(Schema.String),
  developer_name: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  website_url: Schema.optional(Schema.String),
  logo_url: Schema.optional(Schema.String),
  composer_icon_url: Schema.optional(Schema.String),
});

const ChatGptPublicPluginRelease = Schema.Struct({
  version: Schema.optional(Schema.String),
  display_name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  app_ids: Schema.optional(Schema.Array(Schema.String)),
  app_templates: Schema.optional(Schema.Array(Schema.Unknown)),
  interface: Schema.optional(ChatGptPublicPluginReleaseInterface),
});

const ChatGptPublicPluginDirectoryItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  release: ChatGptPublicPluginRelease,
});
type ChatGptPublicPluginDirectoryItem = typeof ChatGptPublicPluginDirectoryItem.Type;
const decodeChatGptPublicPluginDirectoryItem = Schema.decodeUnknownOption(
  ChatGptPublicPluginDirectoryItem,
);

const ChatGptPublicPluginListResponse = Schema.Struct({
  plugins: Schema.Array(Schema.Unknown),
  pagination: Schema.optional(
    Schema.Struct({
      next_page_token: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
export const decodeChatGptPublicPluginListResponse = Schema.decodeUnknownEffect(
  ChatGptPublicPluginListResponse,
);

const CodexAuthTokens = Schema.Struct({
  tokens: Schema.Struct({
    access_token: Schema.String,
    account_id: Schema.optional(Schema.String),
  }),
});
export const decodeCodexChatGptAccessToken = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CodexAuthTokens),
);

function firstText(...values: ReadonlyArray<string | null | undefined>): string | null {
  for (const value of values) {
    const cleaned = value?.trim();
    if (cleaned) return cleaned;
  }
  return null;
}

export function chatGptPublicPluginFromDirectoryItem(
  item: ChatGptPublicPluginDirectoryItem,
): ChatGptPublicPlugin {
  const displayName = firstText(item.release.display_name, item.name) ?? item.name;
  const pluginInterface = item.release.interface;
  return {
    id: item.id,
    name: item.name,
    displayName,
    description:
      firstText(
        pluginInterface?.short_description,
        item.release.description,
        pluginInterface?.long_description,
      ) ?? displayName,
    developer: firstText(pluginInterface?.developer_name, "ChatGPT") ?? "ChatGPT",
    category: firstText(pluginInterface?.category, "Other") ?? "Other",
    version: firstText(item.release.version, "Latest") ?? "Latest",
    logoUrl: firstText(pluginInterface?.logo_url, pluginInterface?.composer_icon_url) ?? null,
    homepage: firstText(pluginInterface?.website_url) ?? null,
    appCount: (item.release.app_ids?.length ?? 0) + (item.release.app_templates?.length ?? 0),
    skillCount: 0,
  };
}

export function chatGptPublicPluginsFromListResponse(payload: {
  readonly plugins: ReadonlyArray<unknown>;
}): ChatGptPublicPlugin[] {
  return payload.plugins.flatMap((item) => {
    const decoded = decodeChatGptPublicPluginDirectoryItem(item);
    return Option.isSome(decoded) ? [chatGptPublicPluginFromDirectoryItem(decoded.value)] : [];
  });
}

export function chatGptPublicPluginListUrl(pageToken?: string): string {
  const url = new URL(`${CHATGPT_BACKEND_API_URL}/ps/plugins/list`);
  url.searchParams.set("scope", "GLOBAL");
  url.searchParams.set("limit", String(CHATGPT_PUBLIC_PLUGIN_LIST_PAGE_LIMIT));
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url.toString();
}

export function chatGptPublicPluginSearchUrl(query: string, pageToken?: string): string {
  const url = new URL(`${CHATGPT_BACKEND_API_URL}/ps/plugins/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(CHATGPT_PUBLIC_PLUGIN_LIST_PAGE_LIMIT));
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url.toString();
}

export function chatGptPublicPluginMarketplaceUrl(
  plugin: Pick<ChatGptPublicPlugin, "displayName">,
) {
  const url = new URL("https://chatgpt.com/plugins");
  url.searchParams.set("q", plugin.displayName);
  return url.toString();
}

export function chatGptPublicPluginSourceId(plugin: Pick<ChatGptPublicPlugin, "name">) {
  return `${plugin.name}@${CHATGPT_PUBLIC_MARKETPLACE_SOURCE}`;
}

export function chatGptPublicPluginNameFromPublicId(pluginId: string): string | null {
  const prefix = "codex:";
  const suffix = `@${CHATGPT_PUBLIC_MARKETPLACE_SOURCE}`;
  if (!pluginId.startsWith(prefix) || !pluginId.endsWith(suffix)) return null;
  return pluginId.slice(prefix.length, -suffix.length);
}

export function codexChatGptAuthFromTokens(tokens: {
  readonly access_token: string;
  readonly account_id?: string | undefined;
}): CodexChatGptAuth {
  return {
    accessToken: tokens.access_token,
    accountId: firstText(tokens.account_id),
  };
}
