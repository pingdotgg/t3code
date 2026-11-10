import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cursorSdkModelSelection } from "./sdkModel.ts";
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
