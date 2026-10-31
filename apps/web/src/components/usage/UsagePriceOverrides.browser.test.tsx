import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const ENVIRONMENT_ID = vi.hoisted(() => "workstation");

vi.mock(import("~/state/presentation"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  const presentation = {
    entry: { target: { label: "workstation" } },
    connection: { phase: "connected" },
    serverConfig: {
      environment: { capabilities: { usagePriceOverrides: true, usageModelAliases: true } },
    },
  };
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsAtom: Atom.make(new Map([[ENVIRONMENT_ID, presentation]])) as never,
    },
  };
});
vi.mock(import("~/state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  const settings = Atom.make({ usagePriceOverrides: {}, usageModelAliases: {} });
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: (() => settings) as never,
    },
  };
});
vi.mock(import("~/state/session"), async (original) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const actual = await original();
  const session = Atom.make(
    AsyncResult.success({ authenticated: true, scopes: ["settings:write"] }),
  );
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (() => session) as never,
    },
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

import { UsagePriceOverrides } from "./UsagePriceOverrides";

const renderPrices = (initialModel?: string) =>
  render(
    <UsagePriceOverrides
      usage={[]}
      initialSelectedEnvironmentIds={null}
      initialModel={initialModel}
      onOpenChange={() => {}}
    />,
  );

describe("UsagePriceOverrides", () => {
  it("waits for a price before flagging an unpriced model's new row", async () => {
    await using _screen = await renderPrices("glm-5.3");
    const modelId = page.getByLabelText("New model ID");
    await expect.element(modelId).toHaveValue("glm-5.3");

    expect(page.getByRole("alert").elements()).toEqual([]);
    await expect.element(modelId).not.toHaveAttribute("aria-invalid");
    await expect.element(page.getByRole("button", { name: "Save changes" })).toBeDisabled();

    await userEvent.type(page.getByLabelText("Input price for glm-5.3"), "2");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Output is required on workstation.");
    await expect.element(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("does not flag a new row while only its model ID is typed", async () => {
    await using _screen = await renderPrices();
    await userEvent.click(page.getByRole("button", { name: "Add model price" }));
    const modelId = page.getByLabelText("New model ID");
    await userEvent.type(modelId, "mx");
    await expect.element(modelId).toHaveValue("mx");

    expect(page.getByRole("alert").elements()).toEqual([]);
    await expect.element(modelId).not.toHaveAttribute("aria-invalid");
  });
});
