import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ClaudeSettings, ZaiSettings } from "@t3tools/contracts";

import { ZaiDriver } from "./ZaiDriver.ts";
import {
  claudeSettingsForZai,
  DEFAULT_ZAI_HOME_PATH,
  resolveZaiApiEndpoint,
  ZAI_ANTHROPIC_BASE_URL,
  zaiInstanceEnvironment,
} from "./ZaiHome.ts";
import { makeClaudeContinuationGroupKey } from "./ClaudeHome.ts";

const decodeZaiSettings = Schema.decodeSync(ZaiSettings);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

describe("ZaiHome", () => {
  it("resolves the default endpoint and home path from empty settings", () => {
    const settings = decodeZaiSettings({});
    expect(resolveZaiApiEndpoint(settings)).toBe(ZAI_ANTHROPIC_BASE_URL);
    expect(claudeSettingsForZai(settings).homePath).toBe(DEFAULT_ZAI_HOME_PATH);
  });

  it("honors an explicit endpoint and home path", () => {
    const settings = decodeZaiSettings({
      apiEndpoint: "https://open.bigmodel.cn/api/anthropic",
      homePath: "~/.claude-work",
    });
    expect(resolveZaiApiEndpoint(settings)).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(claudeSettingsForZai(settings).homePath).toBe("~/.claude-work");
  });

  it("synthesizes endpoint and token env with user entries winning", () => {
    const settings = decodeZaiSettings({ apiKey: "key-from-settings" });
    const entries = zaiInstanceEnvironment(settings, [
      { name: "ANTHROPIC_AUTH_TOKEN", value: "key-from-env", sensitive: true },
    ]);

    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get("ANTHROPIC_BASE_URL")?.value).toBe(ZAI_ANTHROPIC_BASE_URL);
    // The user-declared token must win over the config-derived one, and the
    // merged environment applies later entries over earlier ones.
    expect(entries.filter((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN")).toHaveLength(2);
    expect(
      entries.filter((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN").at(-1)?.value,
    ).toBe("key-from-env");
  });

  it("omits the token entry when no API key is configured", () => {
    const entries = zaiInstanceEnvironment(decodeZaiSettings({}), undefined);
    expect(entries.map((entry) => entry.name)).toEqual(["ANTHROPIC_BASE_URL"]);
  });
});

it.layer(NodeServices.layer)("zai instance isolation", (it) => {
  it.effect("keys Z.ai continuation apart from stock Claude", () =>
    Effect.gen(function* () {
      const zaiKey = yield* makeClaudeContinuationGroupKey(
        claudeSettingsForZai(decodeZaiSettings({})),
      );
      const claudeKey = yield* makeClaudeContinuationGroupKey(decodeClaudeSettings({}));
      expect(zaiKey).toContain(".claude-zai");
      expect(zaiKey).not.toBe(claudeKey);
    }),
  );
});

describe("ZaiDriver", () => {
  it("registers under the zai driver kind with opt-in defaults", () => {
    expect(String(ZaiDriver.driverKind)).toBe("zai");
    expect(ZaiDriver.metadata.displayName).toBe("Z.ai");
    expect(ZaiDriver.metadata.supportsMultipleInstances).toBe(true);
    expect(ZaiDriver.defaultConfig().enabled).toBe(false);
    expect(ZaiDriver.configSchema).toBe(ZaiSettings);
  });
});
