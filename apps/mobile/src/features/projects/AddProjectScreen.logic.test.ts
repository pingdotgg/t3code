import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { newTaskFlowKey } from "../threads/new-task-flow-state";
import { chooserDraftKey, resolveAddProjectEnvironment } from "./AddProjectScreen.logic";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

function environment(environmentId: EnvironmentId, connectionState: EnvironmentConnectionPhase) {
  return { environmentId, connectionState };
}

describe("resolveAddProjectEnvironment", () => {
  it("does not redirect an explicit unavailable environment to another environment", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "offline"), environment(ENVIRONMENT_B, "connected")],
        ENVIRONMENT_A,
      ),
    ).toBeNull();
  });
});

describe("chooserDraftKey", () => {
  const home = { key: "home", name: "Home" };
  const draftRoute = { key: "thread", name: "Thread", params: { draft: { requestId: "r1" } } };
  const chooser = { key: "chooser", name: "NewTaskProject" };
  const addProject = [
    { key: "add", name: "AddProject" },
    { key: "local", name: "AddProjectLocal" },
  ];
  const flowDraftKeys = new Map([[newTaskFlowKey(draftRoute), "new-task:typed"]]);
  const readFlowDraftKey = (flowKey: string) => flowDraftKeys.get(flowKey) ?? null;

  it("picks the added project for the draft whose chooser opened Add project", () => {
    expect(chooserDraftKey([home, draftRoute, chooser, ...addProject], readFlowDraftKey)).toBe(
      "new-task:typed",
    );
    const savedChooser = { ...chooser, params: { draftId: "new-task:saved" } };
    expect(chooserDraftKey([home, savedChooser, ...addProject], readFlowDraftKey)).toBe(
      "new-task:saved",
    );
  });

  it("picks no draft when Add project opened outside the chooser", () => {
    expect(chooserDraftKey([home, draftRoute, ...addProject], readFlowDraftKey)).toBeNull();
  });
});
