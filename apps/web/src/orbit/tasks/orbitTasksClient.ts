import {
  createOrbitTasksClient,
  type OrbitTasksClient,
} from "@t3tools/client-runtime/orbit-gateway";

import { desktopOrbitGatewayTransport } from "../desktopOrbitGateway";

// Only the desktop main process reaches Orbit's Gateway: browsers fail its WireGuard Node auth,
// its CORS allows no origin, and they cannot resolve or trust gateway.orbit.
export const ORBIT_TASKS_WEB_REASON = "Tasks needs the Conn desktop app.";

export const ORBIT_TASKS_FIXTURE_SCENARIOS = [
  "default",
  "empty",
  "not-a-node",
  "access-required",
  "extension-disabled",
  "unreachable",
] as const;
export type OrbitTasksFixtureScenario = (typeof ORBIT_TASKS_FIXTURE_SCENARIOS)[number];

/** Dev builds only: localStorage `conn:orbit-tasks-fixture` names a fixture scenario. */
function fixtureScenario(): OrbitTasksFixtureScenario | null {
  if (!import.meta.env.DEV) return null;
  let value: string | null = null;
  try {
    value = window.localStorage.getItem("conn:orbit-tasks-fixture");
  } catch {
    return null;
  }
  return ORBIT_TASKS_FIXTURE_SCENARIOS.find((scenario) => scenario === value) ?? null;
}

/** Whether Tasks can work in this app, and why not. Read once per render, it is cheap. */
export function orbitTasksAvailability():
  | { available: true }
  | { available: false; reason: string } {
  return window.desktopBridge?.orbitGatewaySend !== undefined || fixtureScenario() !== null
    ? { available: true }
    : { available: false, reason: ORBIT_TASKS_WEB_REASON };
}

let client: Promise<OrbitTasksClient | null> | null = null;

/** One client per window, so slice 3's realtime notices reach every open Tasks tab. */
export function loadOrbitTasksClient(): Promise<OrbitTasksClient | null> {
  client ??= (async () => {
    const scenario = fixtureScenario();
    if (scenario !== null) {
      const { fixtureOrbitTasksTransport } = await import("./orbitTasksFixtures");
      return createOrbitTasksClient(fixtureOrbitTasksTransport(scenario));
    }
    const transport = desktopOrbitGatewayTransport();
    return transport ? createOrbitTasksClient(transport) : null;
  })();
  return client;
}
