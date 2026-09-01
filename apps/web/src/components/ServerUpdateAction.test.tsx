import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  connectionPhase: "connected",
  updateServer: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn() }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateServer: Symbol("updateServer") },
}));
vi.mock("~/state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: testState.connectionPhase } },
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateServer,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.toast },
}));

import { ServerUpdateAction, ServerUpdateProgress } from "./ServerUpdateAction";
import { Button } from "./ui/button";

type ActionElement = ReactElement<{
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}>;

function renderActionResult(selfUpdate: "boot-service" | null = "boot-service") {
  return ServerUpdateAction({
    environmentId: "env-test" as EnvironmentId,
    serverLabel: "Test server",
    selfUpdate,
    targetVersion: "0.0.31",
  });
}

function renderAction(selfUpdate: "boot-service" | null = "boot-service"): ActionElement {
  const result = renderActionResult(selfUpdate);

  function findAction(node: ReactNode): ActionElement | null {
    if (!isValidElement(node)) {
      return null;
    }
    if (node.type === Button) {
      return node as ActionElement;
    }

    const props = node.props as { readonly children?: ReactNode; readonly render?: ReactNode };
    return (
      findAction(props.render) ??
      Children.toArray(props.children)
        .map(findAction)
        .find((action) => action !== null) ??
      null
    );
  }

  const action = findAction(result);
  if (action === null) {
    throw new Error("Server update action button not found");
  }
  return action;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!isValidElement(node)) {
    return "";
  }

  const props = node.props as { readonly children?: ReactNode };
  return Children.toArray(props.children).map(textContent).join("");
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ServerUpdateAction", () => {
  beforeEach(() => {
    testState.connectionPhase = "connected";
    testState.updateServer.mockReset();
    testState.toast.mockReset();
  });

  it.each(["available", "offline", "connecting", "reconnecting", "error"])(
    "disables self-update while the environment is %s",
    async (connectionPhase) => {
      testState.connectionPhase = connectionPhase;

      const action = renderAction();
      action.props.onClick?.();
      await flushPromises();

      expect(action.props.disabled).toBe(true);
      expect(testState.updateServer).not.toHaveBeenCalled();
    },
  );

  it("enables self-update when the environment connects", () => {
    testState.connectionPhase = "connecting";
    expect(renderAction().props.disabled).toBe(true);

    testState.connectionPhase = "connected";
    expect(renderAction().props.disabled).toBe(false);
  });

  it("explains why self-update is disabled", () => {
    testState.connectionPhase = "connecting";

    expect(textContent(renderActionResult())).toContain("Available once Test server is connected.");
  });

  it("keeps the manual update command available while disconnected", () => {
    testState.connectionPhase = "connecting";

    expect(renderAction(null).props.disabled).not.toBe(true);
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

  it("reports one result when the update action is double-clicked", async () => {
    let finishUpdate: (() => void) | undefined;
    testState.updateServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdate = () =>
            resolve(
              AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
            );
        }),
    );

    const action = renderAction();
    action.props.onClick?.();
    action.props.onClick?.();

    expect(testState.updateServer).toHaveBeenCalledTimes(1);
    finishUpdate?.();
    await flushPromises();
    expect(testState.toast).toHaveBeenCalledTimes(1);
  });

  it("quietly releases the action when the operation is interrupted", async () => {
    testState.updateServer.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.toast).not.toHaveBeenCalled();
  });
});

describe("ServerUpdateProgress", () => {
  it("shows one calm status row for the restart wait", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "resuming",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );

    expect(markup).toContain("Restarting…");
    // The wait state is monochrome and calm: no versions, no step rail, no
    // success/warning colors, one duty-cycled pulse on the dot.
    expect(markup).not.toContain("0.0.30");
    expect(markup).not.toContain("Resum");
    expect(markup).not.toContain("text-success");
    expect(markup).not.toContain("text-primary");
    expect(markup).toContain("animate-status-pulse");
    expect(markup).not.toContain("animate-spin");
  });

  it("folds the sub-second installing handoff into the download phase", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );

    expect(markup).toContain("Downloading…");
    expect(markup).not.toContain("Install");
  });

  it("keeps the failure visible with its retryable error", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "failed",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
          message: "The package could not be verified.",
        }}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The package could not be verified.");
    expect(markup).not.toContain("animate-status-pulse");
  });
});
