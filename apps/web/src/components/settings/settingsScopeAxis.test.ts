import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  environmentAxisValue,
  projectAxisValue,
  selectEnvironmentAxis,
  selectProjectAxis,
  selectSingleEnvironmentScope,
  settingsScopeEnvironmentLabel,
} from "./settingsScopeAxis";

import { resolveSettingsScope } from "./settingsScope";

const first = {
  environmentId: EnvironmentId.make("first"),
  label: "Development",
  displayUrl: "https://first.example.com",
};
const second = {
  environmentId: EnvironmentId.make("second"),
  label: "Development",
  displayUrl: "https://second.example.com",
};

describe("settings scope environment labels", () => {
  it("distinguishes same-name environments by address", () => {
    const environments = [first, second];
    expect(
      environments.map((environment) => settingsScopeEnvironmentLabel(environment, environments)),
    ).toEqual([
      "Development · https://first.example.com",
      "Development · https://second.example.com",
    ]);
  });

  it("falls back to environment IDs when duplicate names have no display URL", () => {
    const environments = [first, second].map((environment) => ({
      ...environment,
      displayUrl: null,
    }));
    expect(
      environments.map((environment) => settingsScopeEnvironmentLabel(environment, environments)),
    ).toEqual(["Development · first", "Development · second"]);
  });

  it("keeps unique names compact and removes disambiguation after a rename", () => {
    expect(settingsScopeEnvironmentLabel(first, [first])).toBe("Development");
    expect(settingsScopeEnvironmentLabel(first, [first, { ...second, label: "Production" }])).toBe(
      "Development",
    );
  });
});

describe("settings scope axes", () => {
  it("maps each axis to its search key and back", () => {
    expect(projectAxisValue({})).toBe("all");
    expect(projectAxisValue({ project: "app" })).toBe("app");
    expect(selectProjectAxis({ machine: "second" }, "app")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis({ machine: "second", project: "app" }, "all")).toEqual({
      machine: "second",
    });
    expect(selectEnvironmentAxis({ project: "app" }, "first")).toEqual({
      project: "app",
      machine: "first",
    });
    expect(selectEnvironmentAxis({ project: "app", machine: "first" }, "all")).toEqual({
      project: "app",
    });
  });

  it("drops a checkout narrowing from older links when either axis changes", () => {
    const checkout = { project: "app", checkout: "app@first", machine: "first" };
    expect(selectEnvironmentAxis(checkout, "second")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis(checkout, "app")).toEqual({ project: "app", machine: "first" });
  });
});

describe("environmentAxisValue", () => {
  it("shows the checkout's environment for a legacy checkout link", () => {
    expect(environmentAxisValue({ project: "p", checkout: "c" }, "laptop")).toBe("laptop");
    expect(environmentAxisValue({ project: "p" }, null)).toBe("all");
    expect(environmentAxisValue({ machine: "desk" }, "laptop")).toBe("desk");
  });
});

describe("single environment provider scope", () => {
  const environments = [first, second].map((environment) => ({
    ...environment,
    connection: { phase: "connected" as const },
  }));

  it("defaults to the primary environment and resolves exactly one write target", () => {
    const search = selectSingleEnvironmentScope(
      {},
      resolveSettingsScope({}, [], environments),
      environments,
      second.environmentId,
    );
    expect(search).toEqual({ machine: second.environmentId });
    expect(resolveSettingsScope(search, [], environments).environmentIds).toEqual([
      second.environmentId,
    ]);
  });

  it("keeps an explicit offline or removed environment instead of switching targets", () => {
    const search = { machine: "removed" };
    expect(
      selectSingleEnvironmentScope(
        search,
        resolveSettingsScope(search, [], environments),
        environments,
        first.environmentId,
      ),
    ).toEqual(search);
    const offline = environments.map((environment) => ({
      ...environment,
      connection: { phase: "offline" as const },
    }));
    expect(
      selectSingleEnvironmentScope(
        { machine: second.environmentId },
        resolveSettingsScope({ machine: second.environmentId }, [], offline),
        offline,
        first.environmentId,
      ),
    ).toEqual({ machine: second.environmentId });
  });

  it("falls back to a connected candidate while retaining project and checkout narrowing", () => {
    const search = { project: "app", checkout: "checkout" };
    const scope = {
      kind: "all" as const,
      label: "app",
      members: [],
      environmentIds: [second.environmentId],
    };
    expect(selectSingleEnvironmentScope(search, scope, environments, first.environmentId)).toEqual({
      ...search,
      machine: second.environmentId,
    });
    expect(selectSingleEnvironmentScope({}, resolveSettingsScope({}, [], []), [], null)).toEqual(
      {},
    );
  });
});
