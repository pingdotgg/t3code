import type {
  EnvironmentPresentation,
  PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import type { ServerConfig } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { createRemoteEnvironmentProjectionAtoms } from "./remote-environment-projections";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-2");

function target(environmentId: EnvironmentId, endpoint: string = environmentId) {
  return new PrimaryConnectionTarget({
    environmentId,
    label: `Environment ${environmentId}`,
    httpBaseUrl: `https://${endpoint}.example.test`,
    wsBaseUrl: `wss://${endpoint}.example.test`,
  });
}

function presentation(
  environmentId: EnvironmentId,
  endpoint: string = environmentId,
  serverConfig: ServerConfig | null = null,
): EnvironmentPresentation {
  return {
    entry: { target: target(environmentId, endpoint), profile: Option.none() },
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig,
  };
}

function prepared(
  environmentId: EnvironmentId,
  endpoint: string,
  token: string,
): PreparedConnection {
  return {
    environmentId,
    label: `Environment ${environmentId}`,
    httpBaseUrl: `https://${endpoint}.example.test`,
    socketUrl: `wss://${endpoint}.example.test/ws?token=redacted`,
    httpAuthorization: { _tag: "Bearer", token },
    target: target(environmentId, endpoint),
  };
}

function makeHarness() {
  const presentationAtoms = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<EnvironmentPresentation | null>(presentation(environmentId)),
  );
  const preparedConnectionAtoms = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<Option.Option<PreparedConnection>>(Option.none()),
  );
  const serverConfigAtoms = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ServerConfig | null>(null),
  );
  const projections = createRemoteEnvironmentProjectionAtoms({
    presentationAtom: presentationAtoms,
    preparedConnectionAtom: preparedConnectionAtoms,
    serverConfigAtom: serverConfigAtoms,
  });

  return {
    registry: AtomRegistry.make(),
    presentationAtom: presentationAtoms,
    preparedConnectionAtom: preparedConnectionAtoms,
    serverConfigAtom: serverConfigAtoms,
    projections,
  };
}

describe("remote environment projections", () => {
  it("shares each environment projection and invalidates only changed inputs", () => {
    const harness = makeHarness();
    const firstConsumer = Atom.make((get) =>
      get(harness.projections.savedConnectionAtom(ENVIRONMENT_ID)),
    );
    const secondConsumer = Atom.make((get) =>
      get(harness.projections.savedConnectionAtom(ENVIRONMENT_ID)),
    );
    const otherConsumer = Atom.make((get) =>
      get(harness.projections.savedConnectionAtom(OTHER_ENVIRONMENT_ID)),
    );
    const initial = harness.registry.get(firstConsumer);
    const otherInitial = harness.registry.get(otherConsumer);

    expect(harness.registry.get(secondConsumer)).toBe(initial);
    expect(initial).toMatchObject({
      environmentLabel: "Environment environment-1",
      pairingUrl: "https://environment-1.example.test",
      displayUrl: "https://environment-1.example.test",
      httpBaseUrl: "https://environment-1.example.test",
      wsBaseUrl: "wss://environment-1.example.test",
      bearerToken: null,
    });

    harness.registry.set(
      harness.preparedConnectionAtom(ENVIRONMENT_ID),
      Option.some(prepared(ENVIRONMENT_ID, "rotated", "rotated-token")),
    );
    const rotated = harness.registry.get(firstConsumer);

    expect(rotated).not.toBe(initial);
    expect(rotated).toMatchObject({
      httpBaseUrl: "https://rotated.example.test",
      wsBaseUrl: "wss://rotated.example.test",
      bearerToken: "rotated-token",
    });
    expect(harness.registry.get(secondConsumer)).toBe(rotated);
    expect(harness.registry.get(otherConsumer)).toBe(otherInitial);

    harness.registry.set(harness.preparedConnectionAtom(ENVIRONMENT_ID), Option.none());
    harness.registry.set(
      harness.presentationAtom(ENVIRONMENT_ID),
      presentation(ENVIRONMENT_ID, "catalog-updated"),
    );

    expect(harness.registry.get(firstConsumer)).toMatchObject({
      displayUrl: "https://catalog-updated.example.test",
      httpBaseUrl: "https://catalog-updated.example.test",
      wsBaseUrl: "wss://catalog-updated.example.test",
      bearerToken: null,
    });
  });

  it("preserves saved identity across config-only updates and refreshes runtime state", () => {
    const harness = makeHarness();
    const savedAtom = harness.projections.savedConnectionAtom(ENVIRONMENT_ID);
    const runtimeAtom = harness.projections.runtimeStateAtom(ENVIRONMENT_ID);
    const savedInitial = harness.registry.get(savedAtom);
    const runtimeInitial = harness.registry.get(runtimeAtom);
    const config = { cwd: "/repo" } as ServerConfig;
    const initialPresentation = harness.registry.get(harness.presentationAtom(ENVIRONMENT_ID));

    harness.registry.set(
      harness.presentationAtom(ENVIRONMENT_ID),
      initialPresentation === null ? null : { ...initialPresentation, serverConfig: config },
    );
    harness.registry.set(harness.serverConfigAtom(ENVIRONMENT_ID), config);

    expect(harness.registry.get(savedAtom)).toBe(savedInitial);
    expect(harness.registry.get(runtimeAtom)).not.toBe(runtimeInitial);
    expect(harness.registry.get(runtimeAtom)?.serverConfig).toBe(config);
  });

  it("keeps missing environments null", () => {
    const harness = makeHarness();
    harness.registry.set(harness.presentationAtom(ENVIRONMENT_ID), null);

    expect(
      harness.registry.get(harness.projections.savedConnectionAtom(ENVIRONMENT_ID)),
    ).toBeNull();
    expect(harness.registry.get(harness.projections.runtimeStateAtom(ENVIRONMENT_ID))).toBeNull();
  });
});
