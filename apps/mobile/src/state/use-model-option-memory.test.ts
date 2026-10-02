import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { appAtomRegistry } from "./atom-registry";
import { modelOptionMemoryAtom } from "./use-composer-drafts";
import {
  rememberModelOptions,
  rememberedModelOptions,
  withRememberedModelOptions,
} from "./use-model-option-memory";

const XHIGH = [{ id: "thinking", value: "xhigh" }] as const;
const HIGH = [{ id: "thinking", value: "high" }] as const;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  appAtomRegistry.set(modelOptionMemoryAtom, {});
});

describe("model option memory state", () => {
  it("records and looks up options per instance and model", () => {
    rememberModelOptions("codex", "gpt-5.3-codex", [...XHIGH]);
    rememberModelOptions("codex", "gpt-5.4", [...HIGH]);
    expect(rememberedModelOptions("codex", "gpt-5.3-codex")).toEqual(XHIGH);
    expect(rememberedModelOptions("codex", "gpt-5.4")).toEqual(HIGH);
    expect(rememberedModelOptions("pi", "gpt-5.3-codex")).toBeUndefined();
  });

  it("ignores empty option sets when recording", () => {
    rememberModelOptions("codex", "gpt-5.4", []);
    expect(rememberedModelOptions("codex", "gpt-5.4")).toBeUndefined();
  });
});

describe("withRememberedModelOptions", () => {
  it("restores the remembered options over descriptor defaults", () => {
    rememberModelOptions("codex", "gpt-5.3-codex", [...XHIGH]);
    expect(
      withRememberedModelOptions({
        instanceId: "codex",
        model: "gpt-5.3-codex",
        options: [{ id: "reasoningEffort", value: "low" }],
      }),
    ).toEqual({ instanceId: "codex", model: "gpt-5.3-codex", options: XHIGH });
  });

  it("keeps incoming selections that already match memory", () => {
    rememberModelOptions("pi", "xai/grok-4.6", [...XHIGH]);
    const selection = { instanceId: "pi", model: "xai/grok-4.6", options: [...XHIGH] };
    expect(withRememberedModelOptions(selection)).toBe(selection);
  });

  it("keeps incoming selections when nothing is remembered", () => {
    const selection = { instanceId: "pi", model: "openai-codex/gpt-5.6-sol" };
    expect(withRememberedModelOptions(selection)).toBe(selection);
  });
});
