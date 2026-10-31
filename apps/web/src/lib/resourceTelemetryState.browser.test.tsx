import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type ResourceTelemetryHistory,
  type ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const monitor = vi.hoisted(() => ({
  telemetry:
    vi.fn<
      (args: {
        environmentId: EnvironmentId;
      }) => Atom.Atom<AsyncResult.AsyncResult<ResourceTelemetrySnapshot, MonitorError>>
    >(),
  history:
    vi.fn<
      (args: {
        environmentId: EnvironmentId;
        input: { windowMs: number; bucketMs: number };
      }) => Atom.Atom<AsyncResult.AsyncResult<ResourceTelemetryHistory, MonitorError>>
    >(),
  retry: vi.fn(),
}));

vi.mock("../components/settings/settingsLayout", () => ({
  SettingsSection: ({
    title,
    headerAction,
    children,
  }: {
    title: string;
    headerAction?: ReactNode;
    children: ReactNode;
  }) => (
    <section aria-label={title}>
      {headerAction}
      {children}
    </section>
  ),
}));

vi.mock("../state/environments", () => ({ usePrimaryEnvironment: () => null }));
vi.mock("../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    resourceTelemetry: monitor.telemetry,
    resourceTelemetryHistory: monitor.history,
  },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => monitor.retry }));

import { ResourceTelemetryDiagnostics } from "../components/settings/ResourceTelemetryDiagnostics";

class MonitorError extends Data.TaggedError("MonitorError")<{ readonly message: string }> {}

const environmentId = EnvironmentId.make("remote");
const startError = "The resource monitor is not available.";
const historyError = "Resource history could not start.";

function setup({ retryFails = false, holdRetry = false } = {}) {
  const readAt = DateTime.makeUnsafe(0);
  const aggregate = {
    processCount: 0,
    currentCpuPercent: 0,
    cpuTimeMs: 0,
    currentRssBytes: 0,
    peakRssBytes: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioReadBytesPerSecond: 0,
    ioWriteBytesPerSecond: 0,
    processStarts: 0,
    processExits: 0,
  };
  const source = {
    status: "healthy" as const,
    lastSampleAt: Option.some(readAt),
    lastError: Option.none<string>(),
  };
  const snapshot: ResourceTelemetrySnapshot = {
    readAt,
    sampleIntervalMs: 1000,
    processes: [],
    groups: { backend: aggregate, electron: aggregate, monitor: aggregate, allT3: aggregate },
    power: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: false,
      updatedAt: readAt,
    },
    speedLimitPercent: Option.none(),
    attribution: { readAt, entries: [] },
    health: {
      native: source,
      desktop: source,
      sidecarVersion: Option.none(),
      sidecarPid: Option.none(),
      restartCount: 1,
      collectionDurationMicros: 0,
      scannedProcessCount: 0,
      retainedProcessCount: 0,
      inaccessibleProcessCount: 0,
    },
  };
  const history: ResourceTelemetryHistory = {
    readAt,
    windowMs: 900000,
    bucketMs: 30000,
    sampleIntervalMs: 1000,
    retainedSampleCount: 0,
    buckets: [],
    topProcesses: [],
    health: snapshot.health,
  };
  let running = false;
  const telemetryQueries = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(
      Effect.suspend(() =>
        running ? Effect.succeed(snapshot) : Effect.fail(new MonitorError({ message: startError })),
      ),
    ).pipe(Atom.keepAlive),
  );
  monitor.telemetry.mockReset();
  monitor.telemetry.mockImplementation(({ environmentId }) => telemetryQueries(environmentId));
  const historyReads = vi.fn<(key: string) => void>();
  const historyQueries = Atom.family((key: string) =>
    Atom.make(
      Effect.suspend(() => {
        historyReads(key);
        return running
          ? Effect.succeed(history)
          : Effect.fail(new MonitorError({ message: historyError }));
      }),
    ).pipe(Atom.keepAlive),
  );
  monitor.history.mockReset();
  monitor.history.mockImplementation(({ environmentId, input }) =>
    historyQueries(`${environmentId}:${input.windowMs}`),
  );
  let releaseRetry = () => {};
  const retryRelease = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  monitor.retry.mockReset();
  monitor.retry.mockImplementation(async () => {
    if (holdRetry) await retryRelease;
    if (retryFails)
      return AsyncResult.failure(Cause.fail(new MonitorError({ message: "Restart failed." })));
    running = true;
    return AsyncResult.success({ accepted: true, snapshot });
  });
  const registry = AtomRegistry.make();
  return {
    registry,
    historyQueries,
    historyReads,
    releaseRetry,
    [Symbol.dispose]: () => registry.dispose(),
  };
}

describe("resource monitor retry", () => {
  it("clears the settings and history errors after a successful retry without remounting", async () => {
    using fixture = setup();
    await using screen = await render(
      <RegistryContext.Provider value={fixture.registry}>
        <ResourceTelemetryDiagnostics environmentId={environmentId} />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText(startError, { exact: true })).toBeVisible();
    await expect.element(screen.getByText(historyError, { exact: true })).toBeVisible();

    await screen.getByRole("button", { name: "Retry monitor" }).click();

    await expect.element(screen.getByText(startError, { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByText(historyError, { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByText("Native healthy", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Retry monitor" }))
      .not.toBeInTheDocument();
  });

  it.each([false, true])(
    "refreshes the changed history window only in the retry environment (switch environment: %s)",
    async (switchEnvironment) => {
      using fixture = setup({ holdRetry: true });
      const view = (selectedEnvironment: EnvironmentId) => (
        <RegistryContext.Provider value={fixture.registry}>
          <ResourceTelemetryDiagnostics environmentId={selectedEnvironment} />
        </RegistryContext.Provider>
      );
      await using screen = await render(view(environmentId));
      await expect.element(screen.getByText(historyError, { exact: true })).toBeVisible();
      await screen.getByRole("button", { name: "Retry monitor" }).click();
      await expect.element(screen.getByRole("button", { name: "Retry monitor" })).toBeDisabled();
      const selectedEnvironment = switchEnvironment ? EnvironmentId.make("other") : environmentId;
      if (switchEnvironment) await screen.rerender(view(selectedEnvironment));
      await screen.getByRole("button", { name: "5m", exact: true }).click();
      await expect.element(screen.getByText(historyError, { exact: true })).toBeVisible();
      const selectedKey = `${selectedEnvironment}:300000`;
      expect(fixture.registry.get(fixture.historyQueries(selectedKey))._tag).toBe("Failure");
      fixture.historyReads.mockClear();

      await act(() => fixture.releaseRetry());

      if (switchEnvironment) {
        await expect.element(screen.getByRole("button", { name: "Retry monitor" })).toBeEnabled();
        await expect.element(screen.getByText(historyError, { exact: true })).toBeVisible();
        expect(fixture.registry.get(fixture.historyQueries(selectedKey))._tag).toBe("Failure");
        expect(fixture.historyReads).not.toHaveBeenCalled();
      } else {
        await expect.element(screen.getByText(startError, { exact: true })).not.toBeInTheDocument();
        await expect
          .element(screen.getByText(historyError, { exact: true }))
          .not.toBeInTheDocument();
        expect(fixture.registry.get(fixture.historyQueries(selectedKey))._tag).toBe("Success");
        expect(fixture.historyReads.mock.calls.map(([key]) => key)).toEqual([selectedKey]);
        await screen.getByRole("button", { name: "15m", exact: true }).click();
        await expect
          .element(screen.getByText(historyError, { exact: true }))
          .not.toBeInTheDocument();
      }
      expect(fixture.registry.get(fixture.historyQueries(`${environmentId}:900000`))._tag).toBe(
        "Success",
      );
      expect(monitor.retry).toHaveBeenCalledExactlyOnceWith({ environmentId, input: {} });
    },
  );

  it("keeps the failed monitor and history errors visible when retry fails", async () => {
    using fixture = setup({ retryFails: true });
    await using screen = await render(
      <RegistryContext.Provider value={fixture.registry}>
        <ResourceTelemetryDiagnostics environmentId={environmentId} />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText(startError, { exact: true })).toBeVisible();
    await expect.element(screen.getByText(historyError, { exact: true })).toBeVisible();

    await screen.getByRole("button", { name: "Retry monitor" }).click();

    await expect.element(screen.getByRole("button", { name: "Retry monitor" })).toBeEnabled();
    expect(monitor.retry).toHaveBeenCalledExactlyOnceWith({ environmentId, input: {} });
    await expect.element(screen.getByText(startError, { exact: true })).toBeVisible();
    await expect.element(screen.getByText(historyError, { exact: true })).toBeVisible();
  });
});
