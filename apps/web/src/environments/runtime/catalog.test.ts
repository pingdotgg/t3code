import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "./catalog";

describe("environment runtime catalog stores", () => {
  afterEach(() => {
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
  });

  it("resets the saved environment registry store state", () => {
    const environmentId = EnvironmentId.makeUnsafe("environment-1");

    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId,
      label: "Remote environment",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      bearerToken: "token",
      createdAt: "2026-04-09T00:00:00.000Z",
      lastConnectedAt: null,
    });

    expect(useSavedEnvironmentRegistryStore.getState().byId[environmentId]).toBeDefined();

    resetSavedEnvironmentRegistryStoreForTests();

    expect(useSavedEnvironmentRegistryStore.getState().byId).toEqual({});
  });

  it("resets the saved environment runtime store state", () => {
    const environmentId = EnvironmentId.makeUnsafe("environment-1");

    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      connectionState: "connected",
      connectedAt: "2026-04-09T00:00:00.000Z",
    });

    expect(useSavedEnvironmentRuntimeStore.getState().byId[environmentId]).toBeDefined();

    resetSavedEnvironmentRuntimeStoreForTests();

    expect(useSavedEnvironmentRuntimeStore.getState().byId).toEqual({});
  });
});
