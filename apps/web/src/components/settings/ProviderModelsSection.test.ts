import { describe, expect, it, vi } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

import { reactHookHarness } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ProviderModelsSection } from "./ProviderModelsSection";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

function makeModel(
  slug: string,
  name: string,
  extra?: Partial<ServerProviderModel>,
): ServerProviderModel {
  return {
    slug,
    name,
    isCustom: false,
    capabilities: null,
    ...extra,
  };
}

function findSearchInput(tree: unknown) {
  return visitElements(
    tree,
    (element) => element.type === Input && element.props["aria-label"] === "Search models",
  );
}

function findMoveButton(tree: unknown, modelName: string, direction: "up" | "down") {
  return visitElements(
    tree,
    (element) =>
      element.type === Button && element.props["aria-label"] === `Move ${modelName} ${direction}`,
  );
}

describe("ProviderModelsSection", () => {
  const baseProps = {
    instanceId: ProviderInstanceId.make("test"),
    driverKind: null,
    customModels: [],
    hiddenModels: [],
    favoriteModels: [],
    modelOrder: [],
    onChange: () => {},
    onHiddenModelsChange: () => {},
    onFavoriteModelsChange: () => {},
    onModelOrderChange: () => {},
  } as const;

  it("renders an empty-state message when the search query matches no models", () => {
    const models: ReadonlyArray<ServerProviderModel> = [makeModel("model-a", "Model A")];

    reactHookHarness.reset();
    reactHookHarness.beginRender();
    const tree = ProviderModelsSection({
      ...baseProps,
      models,
    });

    const input = findSearchInput(tree);
    expect(input).not.toBeNull();

    (input!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "nomatch" },
    });

    reactHookHarness.beginRender();
    const nextTree = ProviderModelsSection({
      ...baseProps,
      models,
    });

    const empty = visitElements(
      nextTree,
      (element) =>
        typeof element.type === "string" &&
        element.type === "div" &&
        element.props.children === "No models match your search.",
    );
    expect(empty).not.toBeNull();
  });

  it("disables reorder buttons while a search query is active", () => {
    const models: ReadonlyArray<ServerProviderModel> = [
      makeModel("model-a", "Model A"),
      makeModel("model-b", "Model B"),
    ];

    reactHookHarness.reset();
    reactHookHarness.beginRender();
    const tree = ProviderModelsSection({
      ...baseProps,
      models,
    });

    const input = findSearchInput(tree);
    expect(input).not.toBeNull();

    (input!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "model" },
    });

    reactHookHarness.beginRender();
    const nextTree = ProviderModelsSection({
      ...baseProps,
      models,
    });

    const upButton = findMoveButton(nextTree, "Model B", "up");
    const downButton = findMoveButton(nextTree, "Model A", "down");
    expect(upButton).not.toBeNull();
    expect(downButton).not.toBeNull();
    expect(upButton!.props.disabled).toBe(true);
    expect(downButton!.props.disabled).toBe(true);
  });
});
