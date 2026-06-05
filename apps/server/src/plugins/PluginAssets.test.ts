import { PluginId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { parsePluginClientAssetPath, pluginClientAssetUrl } from "./PluginAssets.ts";

it("PluginAssets owns client asset URL construction and parsing", () => {
  const pluginId = PluginId.make("t3.asset-test");
  const assetUrl = pluginClientAssetUrl(pluginId);

  assert.equal(assetUrl, "/plugins/assets/t3.asset-test/client.js");
  assert.deepEqual(parsePluginClientAssetPath(assetUrl), {
    status: "ok",
    pluginId,
  });
});

it("PluginAssets rejects invalid or unrelated client asset paths", () => {
  assert.deepEqual(parsePluginClientAssetPath("/plugins/assets/not%20allowed/client.js"), {
    status: "invalid",
  });
  assert.deepEqual(parsePluginClientAssetPath("/plugins/assets/t3.asset-test/other.js"), {
    status: "not-found",
  });
});
