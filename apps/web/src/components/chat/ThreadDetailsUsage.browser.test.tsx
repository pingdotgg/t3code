import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

type PresentationMap = ReadonlyMap<
  string,
  { readonly serverConfig: { readonly providers: readonly ServerProvider[] } | null }
>;

const presentationsAtom = vi.hoisted(() => ({
  current: null as Atom.Writable<PresentationMap, PresentationMap> | null,
}));

vi.mock(import("~/state/presentation"), async () => {
  const { Atom } = await import("effect/reactivity");
  const atom = Atom.make<PresentationMap>(new Map());
  presentationsAtom.current = atom;
  return {
    environmentPresentations: {
      presentationsWithProvidersAtom: atom as never,
    },
    environmentSummaries: {} as never,
    useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
  } as never;
});

import { ThreadDetailsUsage } from "./ThreadDetailsUsage";

const checkedAt = "2026-10-30T11:59:00.000Z";
const instanceId = ProviderInstanceId.make("claudeAgent");

function limits(usedPercent: number, at: string): ServerProviderUsageLimits {
  return {
    checkedAt: at,
    credentialFingerprint: "fp-1",
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent,
        windowDurationMins: 300,
        resetsAt: "2026-10-30T13:17:00.000Z",
      },
    ],
  };
}

function claude(usageLimits: ServerProviderUsageLimits): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

function registryWithPeers(peers: readonly ServerProvider[]) {
  const registry = AtomRegistry.make();
  registry.set(
    presentationsAtom.current!,
    new Map([
      ["connecting", { serverConfig: null }],
      ["linked", { serverConfig: { providers: peers } }],
    ]),
  );
  return registry;
}

describe("ThreadDetailsUsage", () => {
  it("shows a linked environment's fresher reading of the same account", async () => {
    const registry = registryWithPeers([claude(limits(25, "2026-10-30T11:58:00.000Z"))]);
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ThreadDetailsUsage
          providerInstanceId={instanceId}
          model={null}
          providers={[claude(limits(80, "2026-10-30T11:00:00.000Z"))]}
          sources={[]}
        />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByRole("link", { name: "Session: 75% left" })).toBeVisible();
  });
});
