import type { SDKModel } from "@cursor/sdk";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cursorSdkModelOffersOptionalMaxMode, cursorSdkModelSelection } from "./sdkModel.ts";
import { buildCursorDiscoveredModelsFromSdk } from "./status.ts";

const instanceId = ProviderInstanceId.make("cursor");
const models = buildCursorDiscoveredModelsFromSdk([
  {
    id: "grok-4.5",
    displayName: "Grok 4.5",
    parameters: [
      {
        id: "effort",
        displayName: "Effort",
        values: [{ value: "low" }, { value: "medium" }, { value: "high" }],
      },
      { id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
    ],
    variants: [
      {
        displayName: "Grok 4.5 High Fast",
        isDefault: true,
        params: [
          { id: "effort", value: "high" },
          { id: "fast", value: "true" },
        ],
      },
    ],
  },
]);

describe("cursorSdkModelSelection", () => {
  it.each([
    {
      name: "fills unset catalog parameters and keeps Fast off",
      options: undefined,
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    },
    {
      name: "keeps explicit options",
      options: [
        { id: "effort", value: "low" },
        { id: "fastMode", value: true },
      ],
      params: [
        { id: "effort", value: "low" },
        { id: "fast", value: "true" },
      ],
    },
  ])("$name", ({ options, params }) => {
    const selection = cursorSdkModelSelection(
      { instanceId, model: "grok-4.5", ...(options === undefined ? {} : { options }) },
      models,
    );
    expect({
      ...selection,
      params: selection.params?.toSorted((a, b) => a.id.localeCompare(b.id)),
    }).toEqual({
      id: "grok-4.5",
      params,
    });
  });

  it("sends no parameters for a model missing from the catalog", () => {
    expect(cursorSdkModelSelection({ instanceId, model: "auto" }, models)).toEqual({
      id: "default",
    });
  });
});

describe("cursorSdkModelSelection Max Mode", () => {
  const sdkModels = [
    {
      id: "composer-2",
      displayName: "Composer 2",
      parameters: [
        { id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
      ],
      variants: [
        { displayName: "Composer", isDefault: true, params: [{ id: "fast", value: "false" }] },
        { displayName: "Composer Max", isMaxMode: true, params: [{ id: "fast", value: "false" }] },
        { displayName: "Composer Fast", params: [{ id: "fast", value: "true" }] },
      ],
    },
    {
      id: "claude-opus-4-8",
      displayName: "Claude Opus 4.8",
      parameters: [{ id: "context", displayName: "Context", values: [{ value: "1m" }] }],
      variants: [
        {
          displayName: "1M",
          isDefault: true,
          isMaxMode: true,
          params: [{ id: "context", value: "1m" }],
        },
      ],
    },
  ] satisfies ReadonlyArray<SDKModel>;
  const catalogModels = buildCursorDiscoveredModelsFromSdk(sdkModels);

  it.each([
    {
      name: "leaves optional Max Mode off by default",
      model: "composer-2",
      options: undefined,
      expected: { id: "composer-2", params: [{ id: "fast", value: "false" }] },
    },
    {
      name: "turns on optional Max Mode without sending it as a parameter",
      model: "composer-2",
      options: [{ id: "maxMode", value: true }],
      expected: { id: "composer-2", params: [{ id: "fast", value: "false" }], maxMode: true },
    },
    {
      name: "drops Max Mode when no variant with the chosen parameters offers it",
      model: "composer-2",
      options: [
        { id: "fastMode", value: true },
        { id: "maxMode", value: true },
      ],
      expected: { id: "composer-2", params: [{ id: "fast", value: "true" }] },
    },
    {
      name: "turns on Max Mode when every matching variant requires it",
      model: "claude-opus-4-8",
      options: undefined,
      expected: {
        id: "claude-opus-4-8",
        params: [{ id: "context", value: "1m" }],
        maxMode: true,
      },
    },
  ])("$name", ({ model, options, expected }) => {
    expect(
      cursorSdkModelSelection(
        { instanceId, model, ...(options === undefined ? {} : { options }) },
        catalogModels,
        sdkModels,
      ),
    ).toEqual(expected);
  });

  it("offers a Max Mode toggle only where it is optional", () => {
    expect(sdkModels.map(cursorSdkModelOffersOptionalMaxMode)).toEqual([true, false]);
  });
});
