import { describe, expect, it } from "vitest";

import {
  createThreadMessageIdsSelectorByRef,
  createThreadMessagesSelectorByRef,
} from "./storeSelectors";
import type { AppState } from "./store";

describe("createThreadMessagesSelectorByRef", () => {
  it("returns a stable empty snapshot when the route has no server thread ref", () => {
    const selector = createThreadMessagesSelectorByRef(null);
    const state = { environmentStateById: {} } as AppState;

    expect(selector(state)).toBe(selector(state));
  });
});

describe("createThreadMessageIdsSelectorByRef", () => {
  it("returns a stable empty snapshot when the route has no server thread ref", () => {
    const selector = createThreadMessageIdsSelectorByRef(null);
    const state = { environmentStateById: {} } as AppState;

    expect(selector(state)).toBe(selector(state));
  });
});
