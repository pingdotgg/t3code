import { describe, expect, it } from "vite-plus/test";

import { toJsonPatch, toPatch } from "./JsonSchemaSettingsForm";
import { pluginSettingsForm } from "./plugins/pluginSettingsForm";

const form = pluginSettingsForm({
  type: "object",
  properties: {
    token: { type: "string", format: "t3-secret" },
    name: { type: "string" },
    count: { type: "integer", minimum: 0 },
  },
});
const fields = form.kind === "fields" ? form.fields : [];

describe("toPatch", () => {
  it("sends only changed fields, removes a cleared secret and keeps an untouched one", () => {
    const saved = { token: "", name: "Ash", count: "2" };
    expect(toPatch(fields, saved, { ...saved, token: null })).toEqual({
      patch: { token: null },
    });
    expect(toPatch(fields, saved, { ...saved, name: " " })).toEqual({ patch: { name: null } });
    expect(toPatch(fields, saved, { ...saved, token: "new" })).toEqual({
      patch: { token: "new" },
    });
    // A half-typed or out-of-range number is a problem to fix, not a cleared field.
    expect(toPatch(fields, saved, { ...saved, count: "1e" })).toEqual({
      problem: "count must be a whole number.",
    });
    expect(toPatch(fields, saved, { ...saved, count: "-1" })).toEqual({
      problem: "count must be at least 0.",
    });
  });
});

describe("toJsonPatch", () => {
  it("removes a key deleted from the JSON", () => {
    expect(toJsonPatch({ a: 1, b: { c: 2 } }, '{ "b": { "c": 3 } }')).toEqual({
      patch: { a: null, b: { c: 3 } },
    });
    expect(toJsonPatch({ a: 1 }, "[]")).toEqual({ problem: "Settings must be a JSON object." });
  });
});
