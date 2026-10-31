import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, type SandboxProviderLimits } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  limits: null as SandboxProviderLimits | null,
  createSandbox: vi.fn(async () => AsyncResult.success({})),
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/connection/onboarding"), async (original) => ({
  ...(await original()),
  connectPairing: (async () => AsyncResult.success(undefined)) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (() => true) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      sandboxesProviders: (() => "providers") as never,
      sandboxesEnvironments: (() => "environments") as never,
      sandboxesLimits: (() => "limits") as never,
      sandboxesCreate: mocks.createSandbox as never,
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data:
      atom === "providers"
        ? {
            providers: [
              {
                kind: "boat",
                label: "Boat",
                detail: "Full Ubuntu VMs.",
                apiKeyLabel: "Boat API key",
                apiKeyPlaceholder: "boat_...",
                docsUrl: "https://docs.boat.dev/api-keys",
                configured: true,
                sizes: [
                  { id: "small", label: "Small", detail: "2 vCPU" },
                  { id: "default", label: "Default", detail: "4 vCPU" },
                ],
                capabilities: {
                  limits: true,
                  stopResume: true,
                  credentialEnvironments: false,
                  extend: true,
                },
              },
            ],
          }
        : atom === "limits"
          ? { limits: mocks.limits }
          : null,
    isPending: false,
    error: null,
    refresh: () => {},
  })) as never,
}));

import { SandboxEnvironmentFields } from "./SandboxEnvironmentFields";

function setup(limits: SandboxProviderLimits) {
  mocks.limits = limits;
  mocks.createSandbox.mockClear();
}

const fields = () => (
  <SandboxEnvironmentFields
    environmentId={EnvironmentId.make("11111111-1111-4111-8111-111111111111")}
    error={null}
    onErrorChange={() => {}}
    onDone={() => {}}
  />
);

describe("SandboxEnvironmentFields", () => {
  it("asks once before a start the provider will charge for", async () => {
    setup({
      canStart: true,
      startCost: "paid",
      startDollars: 0.03,
      starts: [{ window: "hour", limit: 60, used: 60, remaining: 0 }],
    });
    await using _screen = await render(fields());

    await userEvent.click(page.getByRole("button", { name: "Create Boat sandbox" }));
    await expect.element(page.getByText("This start will be charged about $0.03.")).toBeVisible();
    expect(mocks.createSandbox).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "Create anyway" }));
    expect(mocks.createSandbox).toHaveBeenCalledOnce();
  });

  it("disables creating when the provider would refuse the start", async () => {
    setup({
      canStart: false,
      blockedReason: "Your trial has ended.",
      billingUrl: "https://boat.dev/dashboard?tab=billing",
    });
    await using _screen = await render(fields());

    await expect.element(page.getByText("Your trial has ended.", { exact: false })).toBeVisible();
    await expect.element(page.getByRole("link", { name: "Open billing" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Create Boat sandbox" })).toBeDisabled();
  });
});
