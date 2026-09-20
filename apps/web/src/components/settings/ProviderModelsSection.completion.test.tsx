import { ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import type { CustomModelDefinition } from "@t3tools/shared/model";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const effects = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (cleanup) effects.cleanups.push(cleanup);
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { ProviderModelsSection } from "./ProviderModelsSection";
const change = vi.fn<(next: ReadonlyArray<CustomModelDefinition>) => Promise<boolean>>();
const favorite = vi.fn();
const order = vi.fn();
const instanceId = ProviderInstanceId.make("codex_work");
const custom = { slug: "synthetic", name: "Synthetic", capabilities: null };
function render(existing = false) {
  hooks.beginRender();
  return ProviderModelsSection({
    instanceId,
    driverKind: ProviderDriverKind.make("codex"),
    models: existing ? [{ ...custom, isCustom: true }] : [],
    customModels: existing ? [custom] : [],
    hiddenModels: [],
    favoriteModels: [],
    modelOrder: [],
    onChange: change,
    onHiddenModelsChange: vi.fn(),
    onFavoriteModelsChange: favorite,
    onModelOrderChange: order,
  });
}
function button(tree: ReturnType<typeof render>, text: string) {
  const element = visitElements(
    tree,
    (item) =>
      item.props["aria-label"] === text ||
      item.props.children === text ||
      (Array.isArray(item.props.children) && item.props.children.includes(text)),
  );
  if (!element) throw new Error(`Missing ${text}`);
  return element.props.onClick as () => void;
}
function addForm() {
  button(render(), "Add custom model")();
  const tree = render();
  const input = visitElements(
    tree,
    (item) => item.props.id === `provider-instance-${instanceId}-custom-model`,
  )!;
  (input.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "synthetic" },
  });
  return render();
}
function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<boolean>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("custom model persistence completion", () => {
  beforeEach(() => {
    effects.cleanups.splice(0).forEach((cleanup) => cleanup());
    hooks.reset();
    vi.clearAllMocks();
  });
  it("retains the add draft while pending and closes only after success", async () => {
    const receipt = deferred();
    change.mockReturnValue(receipt.promise);
    const tree = addForm();
    const add = button(tree, "Add");
    add();
    add();
    expect(change).toHaveBeenCalledTimes(1);
    expect(render().props.disabled).toBe(true);
    expect(visitElements(render(), (item) => item.props.role === "status")).not.toBeNull();
    expect(visitElements(render(), (item) => item.props.value === "synthetic")).not.toBeNull();
    receipt.resolve(true);
    await flush();
    expect(
      visitElements(
        render(),
        (item) => item.props.id === `provider-instance-${instanceId}-custom-model`,
      ),
    ).toBeNull();
  });
  it.each(["failure", "rejection"])("keeps the add draft on %s and permits retry", async (kind) => {
    const receipt = deferred();
    change.mockReturnValueOnce(receipt.promise).mockResolvedValue(true);
    button(addForm(), "Add")();
    if (kind === "failure") receipt.resolve(false);
    else receipt.reject(new Error("synthetic"));
    await flush();
    const tree = render();
    expect(visitElements(tree, (item) => item.props.value === "synthetic")).not.toBeNull();
    expect(visitElements(tree, (item) => item.props.role === "alert")).not.toBeNull();
    button(tree, "Add")();
    await flush();
    expect(change).toHaveBeenCalledTimes(2);
    expect(
      visitElements(
        render(),
        (item) => item.props.id === `provider-instance-${instanceId}-custom-model`,
      ),
    ).toBeNull();
  });
  it("keeps an edit open until persistence succeeds", async () => {
    const receipt = deferred();
    change.mockReturnValueOnce(receipt.promise).mockResolvedValue(true);
    button(render(true), "Edit synthetic")();
    const editor = () =>
      visitElements(render(true), (item) => typeof item.props.onSave === "function");
    const save = editor()!.props.onSave as (next: CustomModelDefinition) => Promise<void>;
    const pending = save({ ...custom, name: "Renamed" });
    expect(editor()).not.toBeNull();
    receipt.resolve(false);
    await pending;
    expect(editor()).not.toBeNull();
    await (editor()!.props.onSave as typeof save)({ ...custom, name: "Renamed" });
    expect(editor()).toBeNull();
  });
  it("does not remove model preferences or close its editor after failed removal", async () => {
    change.mockResolvedValue(false);
    button(render(true), "Edit synthetic")();
    button(render(true), "Remove synthetic")();
    await flush();
    expect(favorite).not.toHaveBeenCalled();
    expect(order).not.toHaveBeenCalled();
    expect(
      visitElements(render(true), (item) => typeof item.props.onSave === "function"),
    ).not.toBeNull();
  });
  it("ignores a completion after the provider card unmounts", async () => {
    const receipt = deferred();
    change.mockReturnValue(receipt.promise);
    button(addForm(), "Add")();
    effects.cleanups.splice(0).forEach((cleanup) => cleanup());
    hooks.reset();
    addForm();
    receipt.resolve(true);
    await flush();
    expect(visitElements(render(), (item) => item.props.value === "synthetic")).not.toBeNull();
  });
});
