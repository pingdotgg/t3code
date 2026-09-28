import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ProviderInstanceRef,
} from "./providerInstance.ts";

const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);
const decodeProviderInstanceRef = Schema.decodeUnknownSync(ProviderInstanceRef);
const decodeProviderInstanceConfig = Schema.decodeUnknownSync(ProviderInstanceConfig);
const decodeProviderInstanceConfigMap = Schema.decodeUnknownSync(ProviderInstanceConfigMap);

describe("provider slug validation (shared by driver + instance ids)", () => {
  describe("ProviderInstanceId", () => {
    it.each(["codex", "codex_personal", "codex-work", "claudeAgent", "x", "abc123", "ollama"])(
      "accepts %s",
      (id) => {
        expect(decodeProviderInstanceId(id)).toBe(id);
      },
    );

    it.each([
      ["empty string", ""],
      ["leading digit", "1codex"],
      ["leading dash", "-codex"],
      ["leading underscore", "_codex"],
      ["whitespace inside", "codex personal"],
      ["dot inside", "codex.personal"],
      ["slash inside", "codex/personal"],
    ])("rejects %s", (_label, value) => {
      expect(() => decodeProviderInstanceId(value)).toThrow();
    });

    it("trims surrounding whitespace before validating", () => {
      expect(decodeProviderInstanceId("  codex_work  ")).toBe("codex_work");
    });

    it("rejects ids longer than 64 characters", () => {
      const tooLong = "a".repeat(65);
      expect(() => decodeProviderInstanceId(tooLong)).toThrow();
      const justRight = "a".repeat(64);
      expect(decodeProviderInstanceId(justRight)).toBe(justRight);
    });
  });
});

describe("ProviderInstanceRef", () => {
  it("decodes a fork-defined driver ref without complaint", () => {
    const ref = decodeProviderInstanceRef({
      instanceId: "ollama_local",
      driver: "ollama",
    });
    expect(ref.instanceId).toBe("ollama_local");
    expect(ref.driver).toBe("ollama");
  });

  it("rejects refs whose driver field is not a valid slug", () => {
    expect(() =>
      decodeProviderInstanceRef({
        instanceId: "codex",
        driver: "1nope",
      }),
    ).toThrow();
  });
});

describe("ProviderInstanceConfig", () => {
  it("trims provider instance envelope fields", () => {
    const decoded = decodeProviderInstanceConfig({
      driver: "  codex  ",
      displayName: "  Codex Personal  ",
      accentColor: "  #dc2626  ",
      environment: [{ name: "  OPENROUTER_API_KEY  ", value: "  sk-or-test  " }],
    });

    expect(decoded).toMatchObject({
      driver: "codex",
      displayName: "Codex Personal",
      accentColor: "#dc2626",
      environment: [{ name: "OPENROUTER_API_KEY", value: "  sk-or-test  " }],
    });
  });

  it("rejects invalid environment variable names", () => {
    expect(() =>
      decodeProviderInstanceConfig({
        driver: "codex",
        environment: [{ name: "HAS-DASH", value: "x", sensitive: false }],
      }),
    ).toThrow();
  });

  it("rejects a blank displayName (must be trimmed non-empty)", () => {
    expect(() => decodeProviderInstanceConfig({ driver: "codex", displayName: "   " })).toThrow();
  });

  it("rejects driver values that do not satisfy the slug pattern", () => {
    expect(() => decodeProviderInstanceConfig({ driver: "" })).toThrow();
    expect(() => decodeProviderInstanceConfig({ driver: "has spaces" })).toThrow();
  });
});

describe("ProviderInstanceConfigMap", () => {
  it("rejects keys that fail the instance-id pattern", () => {
    expect(() =>
      decodeProviderInstanceConfigMap({
        "1codex": { driver: "codex" },
      }),
    ).toThrow();
  });
});
