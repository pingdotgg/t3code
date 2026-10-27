import type { ReactNode } from "react";
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  Passthrough: ({ children }: { children?: unknown }) => children,
}));

vi.mock("react-native", () => ({ View: harness.Passthrough }));
vi.mock("expo-image", () => ({ Image: () => <img alt="" /> }));
vi.mock("./ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../state/assets", async () => {
  const { Atom } = await import("effect/reactivity");
  const url = Atom.make<string | null>("https://example.test/favicon.png");
  return { projectFaviconUrlAtom: () => url };
});

import { EnvironmentId } from "@t3tools/contracts";

import { ProjectFavicon } from "./ProjectFavicon";

it("mounts the favicon image in the first commit", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const commits: string[] = [];
  try {
    await act(async () =>
      root.render(
        <Profiler id="favicon" onRender={(_id, phase) => commits.push(phase)}>
          <ProjectFavicon
            environmentId={EnvironmentId.make("env-1")}
            projectTitle="Project"
            workspaceRoot="/repo"
          />
        </Profiler>,
      ),
    );
    expect(container.querySelector("img")).not.toBeNull();
    expect(commits).toEqual(["mount"]);
  } finally {
    await act(async () => root.unmount());
  }
});
