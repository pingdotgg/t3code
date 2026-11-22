import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const peers = vi.hoisted(() => ({ providers: [] as unknown[] }));

vi.mock(import("~/state/presentation"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsWithProvidersAtom: Atom.make(
        () =>
          new Map([
            [
              "linked",
              {
                entry: { target: { label: "Linked" } },
                serverConfig: { providers: peers.providers },
              },
            ],
          ]),
      ) as never,
    },
  };
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

describe("ThreadDetailsUsage", () => {
  it("shows a linked environment's fresher reading of the same account", async () => {
    peers.providers = [claude(limits(25, "2026-10-30T11:58:00.000Z"))];
    await using screen = await render(
      <ThreadDetailsUsage
        providerInstanceId={instanceId}
        model={null}
        providers={[claude(limits(80, "2026-10-30T11:00:00.000Z"))]}
        sources={[]}
      />,
    );
    await expect.element(screen.getByRole("link", { name: "Session: 75% left" })).toBeVisible();
  });
});
