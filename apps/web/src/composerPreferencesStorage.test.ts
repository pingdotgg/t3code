import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  readLegacyComposerPreferences,
} from "./composerPreferencesStorage";

function storageWithLegacyState(state: Record<string, unknown>) {
  const raw = JSON.stringify({ version: 2, state });
  return {
    getItem: (key: string) => (key === COMPOSER_DRAFT_STORAGE_KEY ? raw : null),
  };
}

describe("readLegacyComposerPreferences", () => {
  it("falls back past invalid selection identifiers", () => {
    expect(
      readLegacyComposerPreferences(
        storageWithLegacyState({
          stickyProvider: "cursor",
          stickyModelSelection: {
            instanceId: "invalid instance",
            provider: "claudeAgent",
            model: "claude-opus-4-6",
          },
        }),
      ),
    ).toMatchObject({
      stickyModelSelectionByProvider: {
        claudeAgent: {
          instanceId: "claudeAgent",
          model: "claude-opus-4-6",
        },
      },
      stickyActiveProvider: "cursor",
    });

    expect(
      readLegacyComposerPreferences(
        storageWithLegacyState({
          stickyProvider: "cursor",
          stickyModelSelection: {
            instanceId: "invalid instance",
            provider: "invalid provider",
            model: "gpt-5.4",
          },
        }),
      ),
    ).toMatchObject({
      stickyModelSelectionByProvider: {
        cursor: {
          instanceId: "cursor",
          model: "gpt-5.4",
        },
      },
      stickyActiveProvider: "cursor",
    });
  });

  it("does not reinterpret invalid modern fields as pre-v3 preferences", () => {
    expect(
      readLegacyComposerPreferences(
        storageWithLegacyState({
          stickyModelSelectionByProvider: {
            codex: {
              instanceId: "codex",
              model: "",
            },
          },
          stickyActiveProvider: "codex",
          stickyProvider: "codex",
          stickyModel: "gpt-5.6-sol",
        }),
      ),
    ).toBeNull();
  });
});
