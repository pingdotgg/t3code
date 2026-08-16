import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionProfile,
  BearerConnectionTarget,
  type ConnectionCatalogEntry,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";

import { projectEnvironmentConnections } from "./environmentConnections";

describe("projectEnvironmentConnections", () => {
  it("keeps same-environment connections as independent rows with independent states", () => {
    const environmentId = EnvironmentId.make("same-machine");
    const entries = [
      ["home", "Home network", "http://192.168.1.20:3773"],
      ["office", "Office network", "http://10.0.0.20:3773"],
    ].map(([connectionId, label, httpBaseUrl]) => {
      const target = new BearerConnectionTarget({ environmentId, connectionId, label });
      return [
        connectionId,
        {
          target,
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId,
              environmentId,
              label,
              httpBaseUrl,
              wsBaseUrl: httpBaseUrl.replace("http://", "ws://"),
            }),
          ),
        } satisfies ConnectionCatalogEntry,
      ] as const;
    });
    const connected: SupervisorConnectionState = {
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      generation: 1,
    };
    const connecting: SupervisorConnectionState = {
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connecting",
      stage: "opening",
      attempt: 1,
    };

    const rows = projectEnvironmentConnections(
      new Map(entries),
      new Map([
        ["home", connected],
        ["office", connecting],
      ]),
      new Map(),
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.connectionId, row.displayUrl, row.connection.phase])).toEqual([
      ["home", "http://192.168.1.20:3773", "connected"],
      ["office", "http://10.0.0.20:3773", "connecting"],
    ]);
  });
});
