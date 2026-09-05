import { describe, expect, it, vi } from "vite-plus/test";

import {
  getVisibleSettingsSectionIds,
  observeSettingsSectionVisibility,
  type SettingsSectionVisibilityEnvironment,
} from "./settingsSectionVisibility";

type VisibilityEntry = Pick<
  IntersectionObserverEntry,
  "intersectionRatio" | "isIntersecting" | "target"
>;

function createHarness(
  targetIds: ReadonlyArray<string>,
  initialRoot: Element | null = { name: "initial-root" } as unknown as Element,
) {
  const targets = new Map(
    targetIds.map((targetId) => [targetId, { targetId } as unknown as Element]),
  );
  const observed = new Set<Element>();
  const unobserve = vi.fn((target: Element) => observed.delete(target));
  const disconnectIntersections = vi.fn();
  const disconnectMutations = vi.fn();
  const intersectionCallbacks: Array<(entries: ReadonlyArray<VisibilityEntry>) => void> = [];
  const intersectionRoots: Element[] = [];
  let root = initialRoot;
  let onMutation = () => {};

  const environment: SettingsSectionVisibilityEnvironment = {
    findRoot: () => root,
    findTarget: (_root, targetId) => targets.get(targetId) ?? null,
    createIntersectionObserver(callback, observedRoot) {
      intersectionCallbacks.push(callback);
      intersectionRoots.push(observedRoot);
      return {
        observe: (target) => observed.add(target),
        unobserve,
        disconnect: disconnectIntersections,
      };
    },
    createMutationObserver(callback) {
      onMutation = callback;
      return { disconnect: disconnectMutations };
    },
  };

  return {
    environment,
    targets,
    observed,
    unobserve,
    disconnectIntersections,
    disconnectMutations,
    intersectionCallbacks,
    intersectionRoots,
    intersect(entries: ReadonlyArray<VisibilityEntry>) {
      intersectionCallbacks.at(-1)?.(entries);
    },
    mutate() {
      onMutation();
    },
    replaceRoot(nextRoot: Element | null) {
      root = nextRoot;
      onMutation();
    },
  };
}

function visibleEntry(
  target: Element,
  { isIntersecting = true, intersectionRatio = 1 } = {},
): VisibilityEntry {
  return { target, isIntersecting, intersectionRatio };
}

describe("settings section visibility", () => {
  it("does not reuse visibility when returning to the same sectioned route", () => {
    const firstGeneralVisit = { path: "/settings/general" };
    const firstVisibility = {
      scope: firstGeneralVisit,
      targetIds: new Set(["text-generation"]),
    };

    expect(
      getVisibleSettingsSectionIds({
        activePath: "/settings/general",
        scope: firstGeneralVisit,
        visibility: firstVisibility,
      }),
    ).toEqual(new Set(["text-generation"]));
    expect(
      getVisibleSettingsSectionIds({
        activePath: "/settings/providers",
        scope: null,
        visibility: firstVisibility,
      }),
    ).toEqual(new Set());

    const secondGeneralVisit = { path: "/settings/general" };
    expect(
      getVisibleSettingsSectionIds({
        activePath: "/settings/general",
        scope: secondGeneralVisit,
        visibility: firstVisibility,
      }),
    ).toEqual(new Set());
  });

  it("accumulates visible sections and emits them in sidebar order", () => {
    const harness = createHarness(["one", "two", "three"]);
    const emissions: ReadonlyArray<string>[] = [];
    observeSettingsSectionVisibility({
      container: {} as Element,
      targetIds: ["one", "two", "three"],
      onChange: (visible) => emissions.push(visible),
      environment: harness.environment,
    });

    harness.intersect([visibleEntry(harness.targets.get("two")!)]);
    harness.intersect([visibleEntry(harness.targets.get("one")!)]);

    expect(emissions).toEqual([[], ["two"], ["one", "two"]]);
  });

  it("treats zero-ratio and non-intersecting entries as hidden", () => {
    const harness = createHarness(["one", "two"]);
    const emissions: ReadonlyArray<string>[] = [];
    observeSettingsSectionVisibility({
      container: {} as Element,
      targetIds: ["one", "two"],
      onChange: (visible) => emissions.push(visible),
      environment: harness.environment,
    });

    const one = harness.targets.get("one")!;
    const two = harness.targets.get("two")!;
    harness.intersect([visibleEntry(one), visibleEntry(two)]);
    harness.intersect([visibleEntry(one, { intersectionRatio: 0 })]);
    harness.intersect([visibleEntry(two, { isIntersecting: false })]);

    expect(emissions).toEqual([[], ["one", "two"], ["two"], []]);
  });

  it("resyncs replaced and removed targets without retaining stale visibility", () => {
    const harness = createHarness(["dynamic"]);
    const emissions: ReadonlyArray<string>[] = [];
    observeSettingsSectionVisibility({
      container: {} as Element,
      targetIds: ["dynamic"],
      onChange: (visible) => emissions.push(visible),
      environment: harness.environment,
    });

    const firstTarget = harness.targets.get("dynamic")!;
    harness.intersect([visibleEntry(firstTarget)]);
    const replacementTarget = { targetId: "dynamic-replacement" } as unknown as Element;
    harness.targets.set("dynamic", replacementTarget);
    harness.mutate();

    expect(harness.unobserve).toHaveBeenCalledWith(firstTarget);
    expect(harness.observed.has(replacementTarget)).toBe(true);
    expect(emissions.at(-1)).toEqual([]);

    harness.intersect([visibleEntry(firstTarget)]);
    expect(emissions.at(-1)).toEqual([]);
    harness.intersect([visibleEntry(replacementTarget)]);
    expect(emissions.at(-1)).toEqual(["dynamic"]);

    harness.targets.delete("dynamic");
    harness.mutate();
    expect(harness.unobserve).toHaveBeenCalledWith(replacementTarget);
    expect(emissions.at(-1)).toEqual([]);
  });

  it("rebinds when navigation replaces the settings scroll root", () => {
    const harness = createHarness(["section"]);
    const emissions: ReadonlyArray<string>[] = [];
    observeSettingsSectionVisibility({
      container: {} as Element,
      targetIds: ["section"],
      onChange: (visible) => emissions.push(visible),
      environment: harness.environment,
    });

    const firstTarget = harness.targets.get("section")!;
    harness.intersect([visibleEntry(firstTarget)]);
    const firstObserverCallback = harness.intersectionCallbacks[0]!;
    const nextRoot = { name: "next-root" } as unknown as Element;
    const nextTarget = { targetId: "next-section" } as unknown as Element;
    harness.targets.set("section", nextTarget);
    harness.replaceRoot(nextRoot);

    expect(harness.disconnectIntersections).toHaveBeenCalledOnce();
    expect(harness.intersectionRoots.at(-1)).toBe(nextRoot);
    expect(harness.observed.has(nextTarget)).toBe(true);
    expect(emissions.at(-1)).toEqual([]);

    firstObserverCallback([visibleEntry(firstTarget)]);
    expect(emissions.at(-1)).toEqual([]);
    harness.intersect([visibleEntry(nextTarget)]);
    expect(emissions.at(-1)).toEqual(["section"]);
  });

  it("starts observing when the settings scroll root mounts later", () => {
    const harness = createHarness(["section"], null);
    const emissions: ReadonlyArray<string>[] = [];
    observeSettingsSectionVisibility({
      container: {} as Element,
      targetIds: ["section"],
      onChange: (visible) => emissions.push(visible),
      environment: harness.environment,
    });

    expect(emissions).toEqual([[]]);
    expect(harness.intersectionRoots).toEqual([]);

    const root = { name: "mounted-root" } as unknown as Element;
    harness.replaceRoot(root);
    harness.intersect([visibleEntry(harness.targets.get("section")!)]);

    expect(harness.intersectionRoots).toEqual([root]);
    expect(emissions.at(-1)).toEqual(["section"]);
  });

  it("disconnects both observers and ignores callbacks after cleanup", () => {
    const harness = createHarness(["one"]);
    const onChange = vi.fn();
    const cleanup = observeSettingsSectionVisibility({
      container: {} as Element,
      targetIds: ["one"],
      onChange,
      environment: harness.environment,
    });

    cleanup();
    harness.intersect([visibleEntry(harness.targets.get("one")!)]);
    harness.mutate();

    expect(harness.disconnectIntersections).toHaveBeenCalledOnce();
    expect(harness.disconnectMutations).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
