import { T3_ACTIVITY_VIEW } from "@t3tools/client-runtime/linear/search";
import type { LinearTeamMetadata } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildLinearFilterPills, linearFilterPatch } from "./linearFilterMenu";

const metadata = {
  teamId: "t",
  states: [
    { id: "s1", name: "Todo", type: "unstarted", color: "#fff", position: 0 },
    { id: "s2", name: "Done", type: "completed", color: "#0f0", position: 1 },
  ],
  labels: [{ id: "l1", name: "bug", color: "#f00" }],
  cycles: [],
  members: [
    { id: "me", name: "Jan", avatarUrl: null },
    { id: "u2", name: "Sam", avatarUrl: null },
  ],
} as unknown as LinearTeamMetadata;

const input = { search: {}, metadata, views: [], viewer: { id: "me" } };
const patch = (search: object, field: string, value: string) =>
  linearFilterPatch(search, JSON.stringify([field, value]));

describe("buildLinearFilterPills", () => {
  it("defaults to Me, hides the cycle pill without cycles, and lists other members", () => {
    const pills = buildLinearFilterPills(input);
    expect(pills.map((pill) => pill.field)).toEqual([
      "view",
      "assignee",
      "state",
      "priority",
      "label",
      "group",
    ]);
    const assignee = pills.find((pill) => pill.field === "assignee")!;
    expect(assignee).toMatchObject({ label: "Me", active: false });
    expect(assignee.actions.map((action) => action.title)).toEqual(["Me", "Anyone", "Sam"]);
  });

  it("leaves the controls a saved Linear view overrides out, but keeps the T3 view's", () => {
    const fields = (view: string) =>
      buildLinearFilterPills({ ...input, search: { view } }).map((pill) => pill.field);
    expect(fields("custom")).toEqual(["view", "group"]);
    expect(fields(T3_ACTIVITY_VIEW)).toContain("state");
  });

  it("marks selected options and summarizes them in the pill", () => {
    const pills = buildLinearFilterPills({ ...input, search: { states: ["s2"], assignee: "any" } });
    const state = pills.find((pill) => pill.field === "state")!;
    expect(state).toMatchObject({ label: "Done", active: true });
    expect(state.actions.find((action) => action.title === "Done")?.state).toBe("on");
    expect(pills.find((pill) => pill.field === "assignee")).toMatchObject({
      label: "Anyone",
      active: true,
    });
  });
});

describe("linearFilterPatch", () => {
  it("toggles multi-select values and clears them with the empty option", () => {
    expect(patch({}, "state", "s1")).toEqual({ states: ["s1"] });
    expect(patch({ states: ["s1"] }, "state", "s1")).toEqual({ states: undefined });
    expect(patch({ states: ["s1"] }, "state", "s2")).toEqual({ states: ["s1", "s2"] });
    expect(patch({ states: ["s1"] }, "state", "")).toEqual({ states: undefined });
    expect(patch({}, "priority", "0")).toEqual({ priority: [0] });
  });

  it("drops the assignee key when it picks the view's default", () => {
    expect(patch({}, "assignee", "me")).toEqual({ assignee: undefined });
    expect(patch({}, "assignee", "any")).toEqual({ assignee: "any" });
    expect(patch({ view: T3_ACTIVITY_VIEW }, "assignee", "any")).toEqual({ assignee: undefined });
  });

  it("rejects malformed events and out-of-range values", () => {
    expect(linearFilterPatch({}, "not json")).toBeNull();
    expect(linearFilterPatch({}, JSON.stringify(["state"]))).toBeNull();
    expect(patch({}, "priority", "9")).toBeNull();
    expect(patch({}, "group", "team")).toBeNull();
    expect(patch({}, "bogus", "x")).toBeNull();
  });
});
