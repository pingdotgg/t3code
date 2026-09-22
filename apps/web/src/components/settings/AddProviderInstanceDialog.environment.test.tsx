import { EnvironmentId } from "@t3tools/contracts";
import { Cause } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  read: vi.fn(() => ({ providerInstances: {} })),
  update: vi.fn(),
  toast: vi.fn(),
  effect: null as (() => void | (() => void)) | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useEffect: (effect: () => void | (() => void)) => {
      state.effect = effect;
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: state.read }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

const remoteEnvironmentId = EnvironmentId.make("remote-device");
const close = vi.fn();
let cleanup: (() => void) | void;
function render(environmentId = remoteEnvironmentId) {
  hooks.beginRender();
  return AddProviderInstanceDialog({
    open: true,
    environmentId,
    environmentLabel: "Remote device",
    onOpenChange: close,
  });
}
function control(tree: ReturnType<typeof render>, text: string) {
  const element = visitElements(tree, (item) => item.props.children === text);
  if (!element) throw new Error(`Missing control: ${text}`);
  return element.props as { onClick: () => void; disabled?: boolean };
}
function prepare() {
  let tree = render();
  cleanup = state.effect?.();
  control(tree, "Next").onClick();
  tree = render();
  const input = visitElements(tree, (item) => item.props.placeholder === "e.g. Work");
  (input!.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "Work" },
  });
  tree = render();
  control(tree, "Next").onClick();
  tree = render();
  const config = visitElements(tree, (item) => item.props.idPrefix === "add-provider-codex");
  (config!.props.onChange as (value: Record<string, unknown>) => void)({
    binaryPath: "/synthetic/codex",
  });
  return render();
}
function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AddProviderInstanceDialog acknowledged save", () => {
  beforeEach(() => {
    cleanup?.();
    cleanup = undefined;
    hooks.reset();
    vi.clearAllMocks();
  });

  it("waits for persistence on the selected environment and ignores duplicate clicks", async () => {
    const receipt = deferred<AsyncResult.Success<null>>();
    state.update.mockReturnValue(receipt.promise);
    const tree = prepare();
    const add = control(tree, "Add instance");
    add.onClick();
    add.onClick();
    expect(state.update).toHaveBeenCalledTimes(1);
    expect(state.update).toHaveBeenCalledWith({
      environmentId: remoteEnvironmentId,
      input: {
        patch: {
          providerInstances: {
            codex_work: {
              driver: "codex",
              enabled: true,
              displayName: "Work",
              config: { binaryPath: "/synthetic/codex" },
            },
          },
        },
      },
    });
    expect(state.read).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(control(render(), "Adding…").disabled).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
    receipt.resolve(AsyncResult.success(null));
    await flush();
    expect(close).toHaveBeenCalledWith(false);
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it.each(["failure", "interruption", "rejection"])(
    "retains input after %s and allows retry",
    async (kind) => {
      const receipt = deferred<unknown>();
      state.update
        .mockReturnValueOnce(receipt.promise)
        .mockResolvedValue(AsyncResult.success(null));
      control(prepare(), "Add instance").onClick();
      if (kind === "rejection") receipt.reject(new Error("synthetic failure"));
      else
        receipt.resolve(
          AsyncResult.failure(
            kind === "interruption" ? Cause.interrupt(1) : Cause.fail("synthetic failure"),
          ),
        );
      await flush();
      const tree = render();
      expect(visitElements(tree, (item) => item.props.role === "alert")?.props.children).toContain(
        "try again",
      );
      expect(
        visitElements(tree, (item) => item.props.placeholder === "e.g. Work")?.props.value,
      ).toBe("Work");
      expect(
        visitElements(tree, (item) => item.props.idPrefix === "add-provider-codex")?.props.value,
      ).toEqual({ binaryPath: "/synthetic/codex" });
      expect(close).not.toHaveBeenCalled();
      expect(state.toast).not.toHaveBeenCalled();
      control(tree, "Add instance").onClick();
      await flush();
      expect(close).toHaveBeenCalledWith(false);
      expect(state.update).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["reopen", "environment change"])(
    "ignores an old completion after %s",
    async (transition) => {
      const receipt = deferred<AsyncResult.Success<null>>();
      state.update.mockReturnValue(receipt.promise);
      control(prepare(), "Add instance").onClick();
      cleanup?.();
      if (transition === "reopen") hooks.reset();
      render(
        transition === "environment change"
          ? EnvironmentId.make("another-device")
          : remoteEnvironmentId,
      );
      cleanup = state.effect?.();
      receipt.resolve(AsyncResult.success(null));
      await flush();
      expect(close).not.toHaveBeenCalled();
      expect(state.toast).not.toHaveBeenCalled();
    },
  );
});
