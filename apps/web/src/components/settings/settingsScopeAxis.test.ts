import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  selectCheckoutAxis,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeCheckoutChoices,
} from "./settingsScopeAxis";

const checkout = (environmentId: string, physicalProjectKey: string) =>
  ({ environmentId, physicalProjectKey }) as SidebarProjectSnapshot["memberProjects"][number];
const group = (...memberProjects: SidebarProjectSnapshot["memberProjects"]) =>
  ({ memberProjects }) as SidebarProjectSnapshot;

describe("settings scope axes", () => {
  it("drops a checkout narrowing from older links when either axis changes", () => {
    const legacy = { project: "app", checkout: "app@first", machine: "first" };
    expect(selectEnvironmentAxis(legacy, "second")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis(legacy, "app")).toEqual({ project: "app", machine: "first" });
  });

  it("offers checkouts only where an environment cannot tell them apart", () => {
    const a = checkout("laptop", "a");
    const b = checkout("laptop", "b");
    const c = checkout("server", "c");

    expect(settingsScopeCheckoutChoices(group(a, b, c), { machine: "laptop" })).toEqual([a, b]);
    expect(settingsScopeCheckoutChoices(group(a, b), {})).toEqual([a, b]);
    expect(settingsScopeCheckoutChoices(group(a, b, c), { checkout: "b" })).toEqual([a, b]);
    expect(settingsScopeCheckoutChoices(group(a, b, c), {})).toEqual([]);
    expect(settingsScopeCheckoutChoices(group(a, b, c), { machine: "server" })).toEqual([]);
  });

  it("narrows to one checkout and back without losing the chosen environment", () => {
    const search = { project: "app", machine: "laptop" };
    const narrowed = selectCheckoutAxis(search, checkout("laptop", "b"));

    expect(narrowed).toEqual({ project: "app", machine: "laptop", checkout: "b" });
    expect(selectCheckoutAxis(narrowed, null)).toEqual(search);
    expect(selectCheckoutAxis({ project: "app" }, checkout("laptop", "b"))).toEqual(narrowed);
    expect(selectCheckoutAxis({ project: "app", checkout: "b" }, null)).toEqual({ project: "app" });
  });
});
