import { describe, expect, it } from "vitest";

import {
  buildOpenPreviewSearch,
  parsePreviewRouteSearch,
  stripPreviewSearchParams,
} from "./previewRouteSearch";

describe("parsePreviewRouteSearch", () => {
  it("parses preview search values", () => {
    expect(parsePreviewRouteSearch({ preview: "1" })).toEqual({
      preview: "1",
    });
  });

  it("treats numeric and boolean preview toggles as open", () => {
    expect(parsePreviewRouteSearch({ preview: 1 })).toEqual({
      preview: "1",
    });
    expect(parsePreviewRouteSearch({ preview: true })).toEqual({
      preview: "1",
    });
  });

  it("drops preview when closed", () => {
    expect(parsePreviewRouteSearch({ preview: "0" })).toEqual({});
  });
});

describe("preview search builders", () => {
  it("strips only preview-related params", () => {
    expect(
      stripPreviewSearchParams({
        diff: "1",
        preview: "1",
        foo: "bar",
      }),
    ).toEqual({
      diff: "1",
      foo: "bar",
    });
  });

  it("builds preview-open search", () => {
    expect(
      buildOpenPreviewSearch({
        diff: "1",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
        preview: undefined,
        foo: "bar",
      }),
    ).toEqual({
      diff: undefined,
      diffTurnId: undefined,
      diffFilePath: undefined,
      foo: "bar",
      preview: "1",
    });
  });
});
