import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const connect = vi.hoisted(() => vi.fn());
const permission = vi.hoisted(() => ({ allowed: true }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => permission.allowed }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => connect }));

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { LinearConnectionDialog } from "./LinearConnectionDialog";

describe("Linear account dialog", () => {
  beforeEach(() => {
    hooks.reset();
    vi.clearAllMocks();
    permission.allowed = true;
  });
  it("shows a failed connection inside the dialog", async () => {
    connect.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Invalid Linear API key"))));
    const props = {
      open: true,
      environmentId: "primary" as EnvironmentId,
      onOpenChange: vi.fn(),
      onConnected: vi.fn(),
    };

    hooks.beginRender();
    let dialog = LinearConnectionDialog(props);
    const input = visitElements(
      dialog,
      (element) => element.type === Input && element.props["aria-label"] === "Linear API key",
    );
    (
      input?.props.onChange as ((event: { currentTarget: { value: string } }) => void) | undefined
    )?.({ currentTarget: { value: "bad-key" } });

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    const form = visitElements(dialog, (element) => element.type === "form");
    await (
      form?.props.onSubmit as ((event: { preventDefault: () => void }) => Promise<void>) | undefined
    )?.({ preventDefault: vi.fn() });

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    expect(visitElements(dialog, (element) => element.props.role === "alert")?.props.children).toBe(
      "Invalid Linear API key",
    );

    expect(props.onConnected).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(visitElements(dialog, (element) => element.type === Input)?.props.value).toBe("bad-key");

    const done = visitElements(
      dialog,
      (element) => element.type === Button && element.props.children === "Cancel",
    );
    (done?.props.onClick as (() => void) | undefined)?.();
    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    expect(visitElements(dialog, (element) => element.props.role === "alert")).toBeNull();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(visitElements(dialog, (element) => element.type === Input)?.props.value).toBe("");
  });

  it("adds the account and closes the dialog after a successful connection", async () => {
    connect.mockResolvedValue(AsyncResult.success(undefined));
    const onConnected = vi.fn();
    const props = {
      open: true,
      environmentId: "primary" as EnvironmentId,
      onOpenChange: vi.fn(),
      onConnected,
    };

    hooks.beginRender();
    let dialog = LinearConnectionDialog(props);
    const input = visitElements(
      dialog,
      (element) => element.type === Input && element.props["aria-label"] === "Linear API key",
    );
    (
      input?.props.onChange as ((event: { currentTarget: { value: string } }) => void) | undefined
    )?.({ currentTarget: { value: "  new-key  " } });

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    const form = visitElements(dialog, (element) => element.type === "form");
    await (
      form?.props.onSubmit as ((event: { preventDefault: () => void }) => Promise<void>) | undefined
    )?.({ preventDefault: vi.fn() });
    await connect.mock.results[0]?.value;
    await Promise.resolve();

    expect(connect).toHaveBeenCalledWith({
      environmentId: "primary",
      input: { provider: "linear", token: "new-key" },
    });
    expect(onConnected).toHaveBeenCalledOnce();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    expect(visitElements(dialog, (element) => element.type === Input)?.props.value).toBe("");
  });

  it("keeps the API key but blocks adding the account while connect access is revoked", async () => {
    connect.mockResolvedValue(AsyncResult.success(undefined));
    const props = {
      open: true,
      environmentId: "primary" as EnvironmentId,
      onOpenChange: vi.fn(),
      onConnected: vi.fn(),
    };
    const render = () => {
      hooks.beginRender();
      return LinearConnectionDialog(props);
    };
    const submitButton = (dialog: ReturnType<typeof LinearConnectionDialog>) =>
      visitElements(
        dialog,
        (element) => element.type === Button && element.props.type === "submit",
      );
    const submit = (dialog: ReturnType<typeof LinearConnectionDialog>) =>
      (
        visitElements(dialog, (element) => element.type === "form")!.props.onSubmit as (event: {
          preventDefault: () => void;
        }) => Promise<void>
      )({ preventDefault: vi.fn() });

    const input = visitElements(render(), (element) => element.type === Input);
    (input!.props.onChange as (event: { currentTarget: { value: string } }) => void)({
      currentTarget: { value: "lin_api_key" },
    });

    permission.allowed = false;
    let dialog = render();
    expect(submitButton(dialog)?.props.disabled).toBe(true);
    await submit(dialog);
    expect(connect).not.toHaveBeenCalled();
    dialog = render();
    expect(visitElements(dialog, (element) => element.type === Input)?.props.value).toBe(
      "lin_api_key",
    );

    permission.allowed = true;
    dialog = render();
    expect(submitButton(dialog)?.props.disabled).toBe(false);
    await submit(dialog);
    expect(connect).toHaveBeenCalledWith({
      environmentId: "primary",
      input: { provider: "linear", token: "lin_api_key" },
    });
  });
});
