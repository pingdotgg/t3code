import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Exit from "effect/Exit";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  instances: {} as Record<ProviderInstanceId, ProviderInstanceConfig>,
  effects: [] as Array<() => void>,
  save: vi.fn<(...args: unknown[]) => Promise<Exit.Exit<void, Error>>>(),
  onAdded: vi.fn(),
  onOpenChange: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: (effect: () => void) => state.effects.push(effect),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({ providerInstances: state.instances }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: Symbol("updateSettings") },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

class SaveError extends Data.TaggedError("SaveError")<{ readonly message: string }> {}

const remoteEnvironmentId = EnvironmentId.make("remote-device");
const instanceId = ProviderInstanceId.make("codex_work");
const instance = { driver: ProviderDriverKind.make("codex"), displayName: "Work", enabled: true };

function renderDialog() {
  hooks.beginRender();
  state.effects = [];
  const dialog = AddProviderInstanceDialog({
    open: true,
    environmentId: remoteEnvironmentId,
    environmentLabel: "Remote device",
    onOpenChange: state.onOpenChange,
    onAdded: state.onAdded,
  });
  for (const effect of state.effects) effect();
  return dialog;
}

function click(dialog: ReactElement, label: string) {
  const button = visitElements(
    dialog,
    (element) => element.props.children === label && typeof element.props.onClick === "function",
  );
  if (!button) throw new Error(`Button missing: ${label}`);
  return (button.props.onClick as () => Promise<void> | void)();
}

function prepareAccount() {
  let dialog = renderDialog();
  const label = visitElements(dialog, (element) => element.props.placeholder === "e.g. Work");
  if (!label) throw new Error("Account label input missing");
  (label.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "Work" },
  });
  dialog = renderDialog();
  click(dialog, "Next");
  dialog = renderDialog();
  click(dialog, "Next");
  return renderDialog();
}

describe("adding an account on the selected environment", () => {
  beforeEach(() => {
    hooks.reset();
    state.instances = {};
    state.effects = [];
    state.save.mockReset();
    state.onAdded.mockReset();
    state.onOpenChange.mockReset();
    state.toast.mockReset();
  });

  it.each(["response-first", "subscription-first"] as const)(
    "waits for both the save and account in %s order",
    async (order) => {
      let resolveResponse!: (result: Exit.Exit<void, Error>) => void;
      const response = new Promise<Exit.Exit<void, Error>>((resolve) => {
        resolveResponse = resolve;
      });
      state.save.mockReturnValue(response);
      const dialog = prepareAccount();
      const saving = click(dialog, "Add instance");
      click(dialog, "Add instance");
      expect(state.save).toHaveBeenCalledExactlyOnceWith({
        environmentId: remoteEnvironmentId,
        input: { patch: { providerInstances: { [instanceId]: instance } } },
      });

      if (order === "subscription-first") {
        state.instances = { [instanceId]: instance };
        renderDialog();
      } else {
        resolveResponse(Exit.succeed(undefined));
        await saving;
        renderDialog();
      }
      expect(state.onAdded).not.toHaveBeenCalled();
      expect(state.onOpenChange).not.toHaveBeenCalled();
      expect(state.toast).not.toHaveBeenCalled();

      if (order === "subscription-first") {
        resolveResponse(Exit.succeed(undefined));
        await saving;
      } else {
        state.instances = { [instanceId]: instance };
      }
      renderDialog();
      renderDialog();
      expect(state.onAdded).toHaveBeenCalledExactlyOnceWith(instanceId);
      expect(state.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(state.toast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: "success" }),
      );
    },
  );

  it("keeps the draft open after a failed save and permits retry", async () => {
    state.save.mockResolvedValueOnce(Exit.fail(new SaveError({ message: "Device disconnected" })));
    await click(prepareAccount(), "Add instance");
    expect(state.onAdded).not.toHaveBeenCalled();
    expect(state.onOpenChange).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "Device disconnected" }),
    );
    state.save.mockResolvedValueOnce(Exit.succeed(undefined));
    await click(renderDialog(), "Add instance");
    state.instances = { [instanceId]: instance };
    renderDialog();
    expect(state.onAdded).toHaveBeenCalledExactlyOnceWith(instanceId);
  });

  it("allows closing after a successful save while account confirmation is delayed", async () => {
    state.save.mockResolvedValue(Exit.succeed(undefined));
    await click(prepareAccount(), "Add instance");
    click(renderDialog(), "Close");
    expect(state.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(state.onAdded).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  });
});
