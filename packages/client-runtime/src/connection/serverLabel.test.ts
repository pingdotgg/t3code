import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "./model.ts";
import { connectionRoutes } from "./routes.ts";
import { entryWithServerLabel, routesWithUserLabel } from "./serverLabel.ts";

const environmentId = EnvironmentId.make("environment-instance");
const LAN = new BearerConnectionTarget({
  environmentId,
  label: "instance-1846",
  connectionId: "bearer:lan",
});
const RELAY = new RelayConnectionTarget({ environmentId, label: "instance-1846" });

function entry(...targets: ReadonlyArray<BearerConnectionTarget | RelayConnectionTarget>) {
  const [first, ...rest] = targets;
  return {
    target: first!,
    profile: Option.none(),
    enabled: true,
    ...(rest.length === 0
      ? {}
      : { alternateRoutes: rest.map((target) => ({ target, profile: Option.none() })) }),
  } satisfies ConnectionCatalogEntry;
}

function descriptor(
  label: string,
  id: EnvironmentId = environmentId,
): ExecutionEnvironmentDescriptor {
  return {
    environmentId: id,
    label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1.0.0",
    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    capabilities: { repositoryIdentity: true },
  };
}

describe("entryWithServerLabel", () => {
  it("gives every route the server's name", () => {
    const next = entryWithServerLabel(
      entry(LAN, RELAY),
      environmentId,
      descriptor(" task-5003.dlf-leden "),
    );
    expect(next === null ? null : connectionRoutes(next).map((route) => route.target)).toEqual([
      new BearerConnectionTarget({ ...LAN, label: "task-5003.dlf-leden" }),
      new RelayConnectionTarget({ ...RELAY, label: "task-5003.dlf-leden" }),
    ]);
  });

  it("changes nothing for another environment, an empty name, the same name or a chosen name", () => {
    expect(
      entryWithServerLabel(entry(LAN), environmentId, descriptor("x", EnvironmentId.make("other"))),
    ).toBeNull();
    expect(
      entryWithServerLabel(entry(LAN), EnvironmentId.make("other"), descriptor("x")),
    ).toBeNull();
    expect(entryWithServerLabel(entry(LAN), environmentId, descriptor(""))).toBeNull();
    expect(entryWithServerLabel(entry(LAN), environmentId, descriptor("  "))).toBeNull();
    expect(entryWithServerLabel(entry(LAN), environmentId, descriptor("instance-1846"))).toBeNull();
    const chosen = new RelayConnectionTarget({ ...RELAY, label: "Mine", labelSetByUser: true });
    expect(entryWithServerLabel(entry(LAN, chosen), environmentId, descriptor("x"))).toBeNull();
  });
});

describe("routesWithUserLabel", () => {
  it("leaves routes alone when nobody chose a name", () => {
    const routes = connectionRoutes(entry(LAN, RELAY));
    expect(routesWithUserLabel(entry(RELAY), LAN, routes)).toBe(routes);
  });

  it("a newly chosen name holds for every route", () => {
    const renamed = new BearerConnectionTarget({ ...LAN, label: "Mine", labelSetByUser: true });
    const routes = routesWithUserLabel(
      entry(LAN, RELAY),
      renamed,
      connectionRoutes(entry(renamed, RELAY)),
    );
    expect(routes.map((route) => route.target)).toEqual([
      renamed,
      new RelayConnectionTarget({ ...RELAY, label: "Mine", labelSetByUser: true }),
    ]);
  });
});
