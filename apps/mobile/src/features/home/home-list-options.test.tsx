import type { EnvironmentId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ saved: [] as unknown[] }));

vi.mock("../../state/preferences", () => ({ updateMobilePreferencesAtom: {} }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomSet: () => (value: unknown) => harness.saved.push(value),
}));

import { HomeListOptionsProvider, useHomeListOptions } from "./home-list-options";

const ENVIRONMENT = "env-1" as EnvironmentId;
const AVAILABLE = new Set([ENVIRONMENT]);

it("saves the scope from every update made in one event", async () => {
  harness.saved = [];
  let controls: ReturnType<typeof useHomeListOptions> | undefined;
  function Probe(props: { readonly tagEnvironmentIds: ReadonlySet<EnvironmentId> }) {
    const result = useHomeListOptions(AVAILABLE, props.tagEnvironmentIds);
    useLayoutEffect(() => {
      controls = result;
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  const renderWith = (tagEnvironmentIds: ReadonlySet<EnvironmentId>) =>
    act(async () =>
      root.render(
        <HomeListOptionsProvider projectGroupingMode="repository">
          <Probe tagEnvironmentIds={tagEnvironmentIds} />
        </HomeListOptionsProvider>,
      ),
    );
  await renderWith(AVAILABLE);
  act(() => {
    controls!.setSelectedEnvironmentId(ENVIRONMENT);
    controls!.setSelectedProjectKey("env-1:project-1");
  });

  expect(harness.saved.at(-1)).toEqual({
    threadListFilters: { environmentId: ENVIRONMENT, projectKey: "env-1:project-1", tag: null },
  });
  expect(controls!.options.selectedEnvironmentId).toBe(ENVIRONMENT);
  expect(controls!.options.selectedProjectKey).toBe("env-1:project-1");

  // With no server that supports tags, the saved tag stops filtering but is kept.
  act(() => controls!.setSelectedTag("bug"));
  await renderWith(new Set());
  expect(controls!.options.selectedTag).toBeNull();
  expect(harness.saved.at(-1)).toMatchObject({ threadListFilters: { tag: "bug" } });
  await renderWith(AVAILABLE);
  expect(controls!.options.selectedTag).toBe("bug");
  act(() => root.unmount());
});
