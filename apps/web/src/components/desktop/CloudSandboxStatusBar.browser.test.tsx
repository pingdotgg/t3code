import {
  CloudSandboxConnectionTarget,
  ConnectionBlockedError,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import {
  type CloudSandboxEnvironmentStatus,
  EnvironmentId,
  ManagedCloudSandboxResourceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import type { cloudSandboxStatusAtom } from "~/connection/cloudSandbox";

type StatusAtom = ReturnType<typeof cloudSandboxStatusAtom>;
type StatusResult = StatusAtom extends Atom.Atom<infer R> ? R : never;

const localId = EnvironmentId.make("environment-local");
const sandboxId = EnvironmentId.make("environment-sandbox");

const localTarget = new PrimaryConnectionTarget({
  environmentId: localId,
  label: "Local",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});

const sandboxTarget = new CloudSandboxConnectionTarget({
  environmentId: sandboxId,
  label: "Boat Sandbox",
  connectionId: "conn-1",
  driverKind: "boat",
  sandboxId: "sbx-1",
});

function makeStatusAtom(result: StatusResult): StatusAtom {
  return Atom.make<StatusResult>(result);
}

const state = vi.hoisted(() => ({
  preparedByEnvironment: new Map<EnvironmentId, PreparedConnection>(),
  statusAtoms: new Map<EnvironmentId, StatusAtom>(),
}));

function statusAtomFor(environmentId: EnvironmentId): StatusAtom {
  let existing = state.statusAtoms.get(environmentId);
  if (existing === undefined) {
    existing = makeStatusAtom(AsyncResult.initial(true));
    state.statusAtoms.set(environmentId, existing);
  }
  return existing;
}

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  usePreparedConnection: (environmentId: EnvironmentId | null) =>
    environmentId === null
      ? Option.none()
      : Option.fromNullishOr(state.preparedByEnvironment.get(environmentId)),
}));

vi.mock(import("~/connection/cloudSandbox"), async (original) => ({
  ...(await original()),
  cloudSandboxStatusAtom: (environmentId: EnvironmentId) => statusAtomFor(environmentId),
}));

import { CloudSandboxStatusBar } from "./CloudSandboxStatusBar";

function prepareConnections() {
  state.preparedByEnvironment.clear();
  state.statusAtoms.clear();
  state.preparedByEnvironment.set(localId, {
    environmentId: localId,
    label: localTarget.label,
    httpBaseUrl: localTarget.httpBaseUrl,
    socketUrl: localTarget.wsBaseUrl,
    httpAuthorization: null,
    target: localTarget,
  });
  state.preparedByEnvironment.set(sandboxId, {
    environmentId: sandboxId,
    label: sandboxTarget.label,
    httpBaseUrl: "http://127.0.0.1:3773/api/cloud-sandboxes/managed/res-1/proxy",
    socketUrl: "ws://127.0.0.1:3773/api/cloud-sandboxes/managed/res-1/proxy",
    httpAuthorization: null,
    target: sandboxTarget,
  });
}

const readyStatus: CloudSandboxEnvironmentStatus = {
  resourceId: ManagedCloudSandboxResourceId.make("res-1"),
  controllerEnvironmentId: localId,
  sandbox: {
    sandboxId: "sbx-1",
    name: "Boat Sandbox",
    driverKind: "boat",
    state: "ready",
    autoStopDeadline: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  capabilities: {
    diskForking: true,
    desktopStreaming: true,
    usage: true,
    autoStopKeepalive: true,
    publicPortHosting: true,
    hotResize: true,
    rootAccess: true,
  },
  usage: {
    sandboxId: "sbx-1",
    listRateUsdPerHour: 0.036,
    billableSeconds: 120,
    listValueUsd: 0.0012,
    running: true,
    since: "2026-01-01T00:00:00.000Z",
    until: "2026-01-01T00:02:00.000Z",
  },
  recordingIds: [],
};

describe("CloudSandboxStatusBar", () => {
  it("stays hidden on ordinary local threads across loading, null, and error states", async () => {
    prepareConnections();

    state.statusAtoms.set(localId, makeStatusAtom(AsyncResult.initial(true)));
    {
      await using screen = await render(
        <AppAtomRegistryProvider>
          <CloudSandboxStatusBar environmentId={localId} />
        </AppAtomRegistryProvider>,
      );
      await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    }

    state.statusAtoms.set(localId, makeStatusAtom(AsyncResult.success(null)));
    {
      await using screen = await render(
        <AppAtomRegistryProvider>
          <CloudSandboxStatusBar environmentId={localId} />
        </AppAtomRegistryProvider>,
      );
      await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    }

    state.statusAtoms.set(
      localId,
      makeStatusAtom(
        AsyncResult.failure<CloudSandboxEnvironmentStatus | null, ConnectionBlockedError>(
          Cause.fail(new ConnectionBlockedError({ reason: "configuration", detail: "offline" })),
        ),
      ),
    );
    {
      await using screen = await render(
        <AppAtomRegistryProvider>
          <CloudSandboxStatusBar environmentId={localId} />
        </AppAtomRegistryProvider>,
      );
      await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    }
  });

  it("renders loading, unavailable, and active status on sandbox environments", async () => {
    prepareConnections();

    state.statusAtoms.set(sandboxId, makeStatusAtom(AsyncResult.initial(true)));
    {
      await using screen = await render(
        <AppAtomRegistryProvider>
          <CloudSandboxStatusBar environmentId={sandboxId} />
        </AppAtomRegistryProvider>,
      );
      await expect.element(screen.getByText("Cloud sandbox · …")).toBeVisible();
    }

    state.statusAtoms.set(sandboxId, makeStatusAtom(AsyncResult.success(null)));
    {
      await using screen = await render(
        <AppAtomRegistryProvider>
          <CloudSandboxStatusBar environmentId={sandboxId} />
        </AppAtomRegistryProvider>,
      );
      await expect
        .element(screen.getByText("Cloud sandbox · Controller unavailable"))
        .toBeVisible();
    }

    state.statusAtoms.set(localId, makeStatusAtom(AsyncResult.success(readyStatus)));
    {
      await using screen = await render(
        <AppAtomRegistryProvider>
          <CloudSandboxStatusBar environmentId={localId} />
        </AppAtomRegistryProvider>,
      );
      await expect.element(screen.getByText("Cloud sandbox · ready")).toBeVisible();
      await expect.element(screen.getByText("$0.036/h list-rate estimate")).toBeVisible();
    }
  });
});
