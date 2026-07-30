import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn() }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateServer: Symbol("updateServer") },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateServer,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.toast },
}));

import { ServerUpdateAction, ServerUpdateProgress } from "./ServerUpdateAction";

type ActionElement = ReactElement<{
  readonly onClick?: () => void;
}>;

function renderAction(): ActionElement {
  return ServerUpdateAction({
    environmentId: "env-test" as EnvironmentId,
    serverLabel: "Test server",
    selfUpdate: "boot-service",
    targetVersion: "0.0.31",
  }) as ActionElement;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ServerUpdateAction", () => {
  beforeEach(() => {
    testState.updateServer.mockReset();
    testState.toast.mockReset();
  });

  it("reports success only after the shared update flow reconnects", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
    expect(testState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Test server updated",
      description: "Reconnected on t3@0.0.31.",
    });
  });

  it("quietly releases the action when the operation is interrupted", async () => {
    testState.updateServer.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.toast).not.toHaveBeenCalled();
  });
});

describe("ServerUpdateProgress", () => {
  it("renders the chosen horizontal step rail without an animated spinner", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        fromVersion="0.0.30"
        serverLabel="bb-1"
        state={{ status: "running", stage: "resuming", targetVersion: "0.0.31" }}
      />,
    );

    expect(markup).toContain("0.0.30");
    expect(markup).toContain("0.0.31");
    expect(markup).toContain("Download");
    expect(markup).toContain("Install");
    expect(markup).toContain("Resume");
    expect(markup).toContain("Waiting for bb-1 to accept commands.");
    expect(markup).not.toContain("animate-spin");
  });

  it("keeps the failed stage visible with its retryable error", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        fromVersion="0.0.30"
        serverLabel="bb-1"
        state={{
          status: "failed",
          stage: "installing",
          targetVersion: "0.0.31",
          message: "The package could not be verified.",
        }}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The package could not be verified.");
  });
});
