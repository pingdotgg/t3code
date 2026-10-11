import { describe, expect, it } from "vite-plus/test";
import { preferredCloudEnvironment, useCloudRunPreferences } from "./cloudRunStore";

const environments = [
  { id: "project", label: "T3 Code", repository: "pingdotgg/t3code" },
  { id: "other", label: "Other" },
];

describe("cloud destinations", () => {
  it("prefers a valid saved choice, then an unambiguous repository match", () => {
    expect(preferredCloudEnvironment(environments, "other")).toBe("other");
    expect(preferredCloudEnvironment(environments, "deleted")).toBe("project");
    expect(
      preferredCloudEnvironment([{ id: "only", label: "Unrelated" }], undefined),
    ).toBeUndefined();
    expect(
      preferredCloudEnvironment(
        [...environments, { id: "second", label: "Other setup", repository: "pingdotgg/t3code" }],
        undefined,
      ),
    ).toBeUndefined();
  });
  it("isolates preferences across projects and accounts", () => {
    useCloudRunPreferences.setState({ byProject: {} });
    const { remember } = useCloudRunPreferences.getState();
    remember(JSON.stringify(["host", "project-a", "codex"]), "env-a");
    remember(JSON.stringify(["host", "project-b", "codex"]), "env-b");
    remember(JSON.stringify(["host", "project-a", "codex-work"]), "env-work");
    expect(Object.values(useCloudRunPreferences.getState().byProject)).toEqual([
      "env-a",
      "env-b",
      "env-work",
    ]);
  });
});
