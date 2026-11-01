import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { LinkedEnvironmentsSettings } from "./LinkedEnvironmentsSettings";

const hostId = EnvironmentId.make("mac");
const vmLink: PeerLinkSummary = {
  environmentId: EnvironmentId.make("vm"),
  label: "boat-task",
  urls: ["http://boat-task.example.ts.net:3773"],
  access: "full-access",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
};

// What the host's `peerLinks.list` answers. The CLI and agents link machines without this client.
const server = vi.hoisted(() => ({ links: [] as Array<PeerLinkSummary> }));
const listAtom = vi.hoisted(() => ({
  current: null as Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>> | null,
}));

vi.mock(import("~/state/peerLinks"), async (original) => {
  const actual = await original();
  const { Atom: AtomModule } = await import("effect/reactivity");
  const EffectModule = await import("effect/Effect");
  // The real list query's options: stale-while-revalidate, revalidating only when it is built.
  const list = AtomModule.make(EffectModule.sync(() => ({ links: [...server.links] }))).pipe(
    AtomModule.swr({ staleTime: 10_000, revalidateOnMount: true }),
  );
  listAtom.current = list;
  const denied = AtomModule.make(false);
  return {
    ...actual,
    peerLinkEnvironment: {
      ...actual.peerLinkEnvironment,
      list: (() => list) as never,
      link: { ...actual.peerLinkEnvironment.link, permissionAtom: () => denied },
      unlink: { ...actual.peerLinkEnvironment.unlink, permissionAtom: () => denied },
    },
  };
});

/** Stands in for the chat composer, which reads the same list while a thread is open. */
function ComposerReader() {
  const result = useAtomValue(listAtom.current!);
  return AsyncResult.isSuccess(result) ? <p>Composer loaded</p> : null;
}

describe("LinkedEnvironmentsSettings", () => {
  it("shows a link made elsewhere while the composer keeps the list loaded", async () => {
    server.links = [];
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    await using composer = await render(
      <RegistryContext.Provider value={registry}>
        <ComposerReader />
      </RegistryContext.Provider>,
    );
    await expect.element(composer.getByText("Composer loaded")).toBeVisible();

    server.links = [vmLink];
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <LinkedEnvironmentsSettings
          environmentId={hostId}
          environmentLabel={null}
          isSearchTarget={false}
        />
      </RegistryContext.Provider>,
    );

    await expect.element(screen.getByRole("heading", { name: "boat-task" })).toBeVisible();
  });
});
