import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  CHATGPT_PUBLIC_MARKETPLACE_SOURCE,
  chatGptPublicPluginFromDirectoryItem,
  chatGptPublicPluginListUrl,
  chatGptPublicPluginMarketplaceUrl,
  chatGptPublicPluginNameFromPublicId,
  chatGptPublicPluginSearchUrl,
  chatGptPublicPluginSourceId,
  chatGptPublicPluginsFromListResponse,
  decodeChatGptPublicPluginListResponse,
  decodeCodexChatGptAccessToken,
} from "./ChatGptPublicPlugins.ts";

const tickTickListing = {
  id: "ticktick-public",
  name: "ticktick",
  release: {
    version: "1.2.0",
    display_name: "TickTick:To-Do List & Calendar",
    description: "Reminder, Planner, Countdown",
    app_ids: ["ticktick-app"],
    interface: {
      short_description: "Reminder, Planner, Countdown",
      developer_name: "TickTick",
      category: "Productivity",
      website_url: "https://ticktick.com",
      logo_url: "https://ticktick.com/icon.png",
    },
  },
};

describe("ChatGptPublicPlugins", () => {
  it.effect("decodes the ChatGPT public directory payload", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeChatGptPublicPluginListResponse({
        plugins: [tickTickListing, { id: "broken" }],
        pagination: { next_page_token: "page-2" },
      });
      const plugins = chatGptPublicPluginsFromListResponse(decoded);
      const plugin = plugins[0]!;

      assert.strictEqual(plugins.length, 1);
      assert.strictEqual(plugin.displayName, "TickTick:To-Do List & Calendar");
      assert.strictEqual(plugin.description, "Reminder, Planner, Countdown");
      assert.strictEqual(plugin.developer, "TickTick");
      assert.strictEqual(plugin.category, "Productivity");
      assert.strictEqual(plugin.appCount, 1);
      assert.strictEqual(plugin.logoUrl, "https://ticktick.com/icon.png");
      assert.strictEqual(
        chatGptPublicPluginSourceId(plugin),
        `ticktick@${CHATGPT_PUBLIC_MARKETPLACE_SOURCE}`,
      );
      assert.strictEqual(
        chatGptPublicPluginMarketplaceUrl(plugin),
        "https://chatgpt.com/plugins?q=TickTick%3ATo-Do+List+%26+Calendar",
      );
      assert.strictEqual(decoded.pagination?.next_page_token, "page-2");
    }),
  );

  it.effect("reads ChatGPT tokens and account id from Codex auth.json", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeCodexChatGptAccessToken(
        '{"tokens":{"access_token":"chatgpt-access-token","account_id":"acct"}}',
      );
      assert.strictEqual(decoded.tokens.access_token, "chatgpt-access-token");
      assert.strictEqual(decoded.tokens.account_id, "acct");
    }),
  );

  it("pages the shared ChatGPT plugin directory and search index", () => {
    assert.strictEqual(
      chatGptPublicPluginListUrl(),
      "https://chatgpt.com/backend-api/ps/plugins/list?scope=GLOBAL&limit=200",
    );
    assert.strictEqual(
      chatGptPublicPluginListUrl("abc"),
      "https://chatgpt.com/backend-api/ps/plugins/list?scope=GLOBAL&limit=200&pageToken=abc",
    );
    assert.strictEqual(
      chatGptPublicPluginSearchUrl("tick"),
      "https://chatgpt.com/backend-api/ps/plugins/search?q=tick&limit=200",
    );
    assert.strictEqual(
      chatGptPublicPluginNameFromPublicId("codex:app-69ddbaba@chatgpt-public"),
      "app-69ddbaba",
    );
  });

  it("maps a directory item without a release interface", () => {
    const plugin = chatGptPublicPluginFromDirectoryItem({
      id: "bare",
      name: "bare-plugin",
      release: { display_name: "Bare Plugin" },
    });
    assert.strictEqual(plugin.displayName, "Bare Plugin");
    assert.strictEqual(plugin.description, "Bare Plugin");
    assert.strictEqual(plugin.developer, "ChatGPT");
  });
});
