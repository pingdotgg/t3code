import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  THREAD_CONVERSATION_MAX_WIDTH_PX,
  THREAD_CONVERSATION_MIN_WIDTH_PX,
  T3HostDisplayPreferencesSchema,
} from "./ipc.ts";

const decodeHostDisplayPreferences = Schema.decodeUnknownSync(T3HostDisplayPreferencesSchema);

const basePreferences = {
  showOpenInPicker: false,
  showCheckoutModeIndicator: false,
  showBranchSelector: false,
  enableTerminal: false,
  enableSourceControlPanel: false,
};

describe("T3HostDisplayPreferencesSchema", () => {
  it("accepts unset and in-range thread conversation widths", () => {
    expect(
      decodeHostDisplayPreferences({
        ...basePreferences,
        threadConversationMaxWidthPx: null,
      }).threadConversationMaxWidthPx,
    ).toBeNull();

    expect(
      decodeHostDisplayPreferences({
        ...basePreferences,
        threadConversationMaxWidthPx: THREAD_CONVERSATION_MIN_WIDTH_PX,
      }).threadConversationMaxWidthPx,
    ).toBe(THREAD_CONVERSATION_MIN_WIDTH_PX);

    expect(
      decodeHostDisplayPreferences({
        ...basePreferences,
        threadConversationMaxWidthPx: THREAD_CONVERSATION_MAX_WIDTH_PX,
      }).threadConversationMaxWidthPx,
    ).toBe(THREAD_CONVERSATION_MAX_WIDTH_PX);
  });

  it("rejects out-of-range thread conversation widths", () => {
    expect(() =>
      decodeHostDisplayPreferences({
        ...basePreferences,
        threadConversationMaxWidthPx: THREAD_CONVERSATION_MIN_WIDTH_PX - 1,
      }),
    ).toThrow();

    expect(() =>
      decodeHostDisplayPreferences({
        ...basePreferences,
        threadConversationMaxWidthPx: THREAD_CONVERSATION_MAX_WIDTH_PX + 1,
      }),
    ).toThrow();
  });
});
