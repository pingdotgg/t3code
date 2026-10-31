import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  CURSOR_SDK_MAX_MODE_OPTION_ID,
  cursorSdkMaxModeForParams,
  cursorSdkModelOffersOptionalMaxMode,
  cursorSdkModelSelection,
} from "./sdkModel.ts";

describe("cursorSdkModelSelection", () => {
  const instanceId = ProviderInstanceId.make("cursor");

  it("sets maxMode when every matching catalog variant requires it", () => {
    const selection = cursorSdkModelSelection(
      {
        instanceId,
        model: "claude-opus-4-8",
        options: [{ id: "contextWindow", value: "1m" }],
      },
      [
        {
          id: "claude-opus-4-8",
          variants: [
            {
              displayName: "1M",
              isMaxMode: true,
              params: [{ id: "context", value: "1m" }],
            },
          ],
        },
      ],
    );
    expect(selection).toEqual({
      id: "claude-opus-4-8",
      params: [{ id: "context", value: "1m" }],
      maxMode: true,
    });
  });

  it("omits maxMode when a matching variant can run without it", () => {
    expect(
      cursorSdkMaxModeForParams(
        {
          variants: [
            {
              displayName: "1M",
              isMaxMode: true,
              params: [{ id: "context", value: "1m" }],
            },
            {
              displayName: "1M standard",
              params: [{ id: "context", value: "1m" }],
            },
          ],
        },
        [{ id: "context", value: "1m" }],
      ),
    ).toBe(false);
  });

  it("sets maxMode from the composer option without forwarding it as an SDK param", () => {
    const catalog = [
      {
        id: "composer-2",
        variants: [
          {
            displayName: "Composer",
            isDefault: true,
            params: [{ id: "fast", value: "false" }],
          },
          {
            displayName: "Composer Max",
            isMaxMode: true,
            params: [{ id: "fast", value: "false" }],
          },
          {
            displayName: "Composer Fast",
            params: [{ id: "fast", value: "true" }],
          },
        ],
      },
    ];
    expect(
      cursorSdkModelSelection(
        {
          instanceId,
          model: "composer-2",
          options: [
            { id: "fastMode", value: false },
            { id: CURSOR_SDK_MAX_MODE_OPTION_ID, value: true },
          ],
        },
        catalog,
      ),
    ).toEqual({
      id: "composer-2",
      params: [{ id: "fast", value: "false" }],
      maxMode: true,
    });
    expect(
      cursorSdkModelSelection(
        {
          instanceId,
          model: "composer-2",
          options: [
            { id: "fastMode", value: false },
            { id: CURSOR_SDK_MAX_MODE_OPTION_ID, value: false },
          ],
        },
        catalog,
      ),
    ).toEqual({
      id: "composer-2",
      params: [{ id: "fast", value: "false" }],
    });
    expect(
      cursorSdkModelSelection(
        {
          instanceId,
          model: "composer-2",
          options: [
            { id: "fastMode", value: true },
            { id: CURSOR_SDK_MAX_MODE_OPTION_ID, value: true },
          ],
        },
        catalog,
      ),
    ).toEqual({
      id: "composer-2",
      params: [{ id: "fast", value: "true" }],
    });
  });
});

describe("cursorSdkModelOffersOptionalMaxMode", () => {
  it("is true when the same params have both max and non-max variants", () => {
    expect(
      cursorSdkModelOffersOptionalMaxMode({
        variants: [
          {
            displayName: "Standard",
            isDefault: true,
            params: [{ id: "fast", value: "false" }],
          },
          {
            displayName: "Max",
            isMaxMode: true,
            params: [{ id: "fast", value: "false" }],
          },
        ],
      }),
    ).toBe(true);
  });

  it("is false when max mode is forced for every matching selection", () => {
    expect(
      cursorSdkModelOffersOptionalMaxMode({
        variants: [
          {
            displayName: "1M",
            isMaxMode: true,
            params: [{ id: "context", value: "1m" }],
          },
        ],
      }),
    ).toBe(false);
  });

  it("is false when no variants use max mode", () => {
    expect(
      cursorSdkModelOffersOptionalMaxMode({
        variants: [
          {
            displayName: "Default",
            isDefault: true,
            params: [{ id: "fast", value: "false" }],
          },
        ],
      }),
    ).toBe(false);
  });
});
