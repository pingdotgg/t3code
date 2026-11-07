import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildHomeEnvironmentFilterActions,
  buildHomeProjectFilterActions,
} from "./home-list-filter-menu";

describe("home list filter menu actions", () => {
  it("keeps environment action ids stable for the native UIMenu", () => {
    const environmentId = EnvironmentId.make("env-1");
    const actions = buildHomeEnvironmentFilterActions({
      environments: [{ environmentId, label: "MacBook" }],
      selectedEnvironmentId: environmentId,
    });
    expect(actions).toEqual([
      { id: "all", title: "All environments", state: "off" },
      { id: "env-1", title: "MacBook", state: "on" },
    ]);
  });

  it("keeps project action ids stable for the native UIMenu", () => {
    const actions = buildHomeProjectFilterActions({
      projects: [{ key: "env-1:project-1", label: "t3code" }],
      selectedProjectKey: null,
    });
    expect(actions).toEqual([
      { id: "all", title: "All projects", state: "on" },
      { id: "env-1:project-1", title: "t3code", state: "off" },
    ]);
  });
});
