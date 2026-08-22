import type { ReactElement } from "react";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  atomCalls: [] as Array<readonly [EnvironmentId, ProviderInstanceId]>,
  values: new Map<string, unknown>(),
}));
const commands = vi.hoisted(() => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
const atoms = vi.hoisted(() => ({
  signIn: Symbol("kimiSignIn"),
  signOut: Symbol("kimiSignOut"),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => state.values.get(atom) ?? { status: "idle" },
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    kimiSignIn: atoms.signIn,
    kimiSignOut: atoms.signOut,
    kimiSignInStateAtom: (environmentId: EnvironmentId, instanceId: ProviderInstanceId) => {
      state.atomCalls.push([environmentId, instanceId]);
      return `${environmentId}:${instanceId}`;
    },
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => (atom === atoms.signIn ? commands.signIn : commands.signOut),
}));

import { KimiSignInControl } from "./KimiSignInControl";

const environmentId = EnvironmentId.make("environment-1");
const personalId = ProviderInstanceId.make("kimi_personal");
const workId = ProviderInstanceId.make("kimi_work");

function renderControl(instanceId: ProviderInstanceId, authenticated = false) {
  hooks.beginRender();
  return KimiSignInControl({ authenticated, environmentId, instanceId }) as ReactElement<
    Record<string, unknown>
  >;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("KimiSignInControl", () => {
  beforeEach(() => {
    hooks.reset();
    state.atomCalls = [];
    state.values.clear();
    commands.signIn.mockReset().mockResolvedValue(undefined);
    commands.signOut.mockReset().mockResolvedValue(undefined);
  });

  it("reads only the selected provider instance's sign-in state", () => {
    state.values.set(`${environmentId}:${personalId}`, {
      status: "waiting",
      verificationUri: "https://auth.example/personal",
    });

    const personal = renderControl(personalId);
    const work = renderControl(workId);

    expect(state.atomCalls).toEqual([
      [environmentId, personalId],
      [environmentId, workId],
    ]);
    expect(
      visitElements(personal, (element) => element.props.href === "https://auth.example/personal"),
    ).not.toBeNull();
    const liveStatus = visitElements(personal, (element) => element.props.role === "status");
    expect(liveStatus?.props["aria-live"]).toBe("polite");
    expect(visitElements(work, (element) => element.props.href !== undefined)).toBeNull();
  });

  it("announces sign-in failures as a polite live status", () => {
    state.values.set(`${environmentId}:${workId}`, {
      status: "failed",
      message: "Kimi sign-in failed.",
    });

    const control = renderControl(workId);
    const failure = visitElements(
      control,
      (element) => element.props.role === "status" && element.props["aria-live"] === "polite",
    );

    expect(failure).not.toBeNull();
    expect(failure?.props.children).toBe("Kimi sign-in failed.");
  });

  it("signs out the authenticated provider instance", async () => {
    const control = renderControl(workId, true);
    const button = visitElements(control, (element) => typeof element.props.onClick === "function");

    (button?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.signOut).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: workId },
    });
    expect(commands.signIn).not.toHaveBeenCalled();
  });
});
