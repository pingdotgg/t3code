import "~/index.css";

import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ServerProvider } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry as registry } from "../../rpc/atomRegistry";

const atoms = vi.hoisted(() => ({ presentations: null as unknown, providers: null as unknown }));

vi.mock(import("../../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      get presentationsAtom() {
        return atoms.presentations as never;
      },
      get providersByEnvironmentAtom() {
        return atoms.providers as never;
      },
    },
  };
});

import { ChatGptWelcomeCoordinator } from "./ChatGptWelcomeCoordinator";

const environmentId = EnvironmentId.make("local");

function sharingCodex(profileId: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(`codex_${profileId}`),
    driver: ProviderDriverKind.make("codex"),
    displayName: `ChatGPT - ${profileId}`,
    installed: true,
    enabled: true,
    version: "test-version",
    status: "ready",
    auth: { status: "authenticated", subscriptionSharing: true, profileId },
    checkedAt: "2026-11-06T00:00:00.000Z",
    models: [],
    skills: [],
    slashCommands: [],
  };
}

describe("ChatGptWelcomeCoordinator", () => {
  it("welcomes each connected ChatGPT profile once", async () => {
    localStorage.removeItem("t3:chatgpt-sharing-welcome:v1");
    const presentations = Atom.make(
      new Map([
        [
          environmentId,
          { connection: { phase: "connected" }, entry: { target: { label: "This Mac" } } },
        ],
      ]),
    ).pipe(Atom.keepAlive);
    const providers = Atom.make(
      new Map<EnvironmentId, ReadonlyArray<ServerProvider>>([
        [environmentId, [sharingCodex("personal")]],
      ]),
    ).pipe(Atom.keepAlive);
    atoms.presentations = presentations;
    atoms.providers = providers;
    const mount = () =>
      render(
        <AppAtomRegistryProvider>
          <ChatGptWelcomeCoordinator />
        </AppAtomRegistryProvider>,
      );
    {
      await using _first = await mount();
      await expect.element(page.getByText("Your ChatGPT plan is connected")).toBeVisible();
      await expect.element(page.getByText("ChatGPT - personal on This Mac")).toBeVisible();
      await userEvent.click(page.getByRole("button", { name: "Continue" }));
      await expect
        .element(page.getByText("Your ChatGPT plan is connected"))
        .not.toBeInTheDocument();
    }

    registry.set(
      providers,
      new Map([[environmentId, [sharingCodex("personal"), sharingCodex("work")]]]),
    );
    await using _second = await mount();
    await expect.element(page.getByText("ChatGPT - work on This Mac")).toBeVisible();
  });
});
