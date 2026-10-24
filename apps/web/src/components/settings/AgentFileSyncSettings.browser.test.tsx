import { RegistryProvider } from "@effect/atom-react";
import type { PropsWithChildren } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ offline: false, writable: true }));

vi.mock(import("../../state/agentFileSync"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const catalog = Atom.make(
    AsyncResult.success({
      skills: [{ path: ".agents/skills/review", name: "Review" }],
      instructions: [],
      warnings: [],
    }),
  );
  const links = Atom.make(AsyncResult.success([]));
  const permissionAtom = Atom.family((id: string) =>
    Atom.make(() => id !== "unavailable" || state.writable),
  );
  return {
    agentFileSync: {
      list: () => catalog,
      links: () => links,
      apply: { permissionAtom },
      manage: { permissionAtom },
    },
  } as never;
});
vi.mock(import("../../state/environments"), () => ({
  useEnvironments: (() => ({
    environments: ["source", "available", "unavailable"].map((id) => ({
      environmentId: id,
      label: id,
      connection: { phase: id === "unavailable" && state.offline ? "offline" : "connected" },
      serverConfig: { environment: { capabilities: { agentFileSync: true } } },
    })),
  })) as never,
}));
vi.mock(import("./SettingsScopeContext"), () => ({
  useSettingsScope: (() => ({
    scope: { kind: "all", label: "All projects" },
    environment: { environmentId: "source" },
  })) as never,
}));
vi.mock(import("./settingsLayout"), () => ({
  SettingsPageContainer: ({ children }: PropsWithChildren) => <>{children}</>,
  SettingsSection: ({ children }: PropsWithChildren) => <>{children}</>,
}));

import { AgentFileSyncSettings } from "./AgentFileSyncSettings";

function setup(reason: string) {
  state.offline = reason === "offline";
  state.writable = reason !== "read-only";
  const key = "t3:agent-file-sync:source:home";
  localStorage.setItem(key, JSON.stringify([".agents/skills/review"]));
  localStorage.setItem(`${key}:targets`, JSON.stringify(["available", "unavailable"]));
  return key;
}

it.each(["offline", "read-only"])(
  "can deselect a saved %s destination and review the remaining destination",
  async (reason) => {
    const key = setup(reason);
    await using screen = await render(
      <RegistryProvider>
        <AgentFileSyncSettings />
      </RegistryProvider>,
    );
    const review = screen.getByRole("button", { name: "Review automatic sync" });
    await expect.element(review).toBeDisabled();
    const unavailable = screen.getByRole("checkbox", { name: /^unavailable/ });
    await expect.element(unavailable).toBeChecked();
    await expect.element(unavailable).toBeEnabled();
    await userEvent.click(unavailable);
    await expect.element(unavailable).not.toBeChecked();
    await expect.element(unavailable).toBeDisabled();
    await expect.element(review).toBeEnabled();
    expect(JSON.parse(localStorage.getItem(`${key}:targets`)!)).toEqual(["available"]);
  },
);
