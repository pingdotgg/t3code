import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceConfig } from "./providerInstance.ts";

const decodeProviderInstanceConfig = Schema.decodeUnknownSync(ProviderInstanceConfig);
const encodeProviderInstanceConfig = Schema.encodeSync(ProviderInstanceConfig);

describe("ProviderInstanceConfig", () => {
  it("keeps the settings-list hidden flag optional so older instances still decode", () => {
    const instance = decodeProviderInstanceConfig({ driver: "claudeAgent" });

    expect(instance.hidden).toBeUndefined();
  });

  it("round-trips an instance hidden from the settings list", () => {
    const instance = decodeProviderInstanceConfig({ driver: "claudeAgent", hidden: true });

    expect(instance.hidden).toBe(true);
    expect(encodeProviderInstanceConfig(instance)).toMatchObject({ hidden: true });
  });
});
