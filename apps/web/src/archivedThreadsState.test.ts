import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { __testing } from "./archivedThreadsState";

describe("archived thread connection keys", () => {
  it("changes when a connection is registered or replaced", () => {
    const environmentId = EnvironmentId.make("environment-1");
    let connection: object | null = null;
    const getConnection = () => connection;

    const disconnectedKey = __testing.readConnectionKey(environmentId, getConnection);
    connection = {};
    const connectedKey = __testing.readConnectionKey(environmentId, getConnection);
    const stableConnectedKey = __testing.readConnectionKey(environmentId, getConnection);
    connection = {};
    const replacementKey = __testing.readConnectionKey(environmentId, getConnection);

    expect(connectedKey).not.toBe(disconnectedKey);
    expect(stableConnectedKey).toBe(connectedKey);
    expect(replacementKey).not.toBe(connectedKey);
  });
});
