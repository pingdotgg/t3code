import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { newSimlockDeviceHost } from "./simlockDeviceHostsSettings.logic";

vi.mock(import("../../state/device"), async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const identityAtom = Atom.make(AsyncResult.initial());
  return {
    deviceSimlockIdentityCheck: (() => identityAtom) as never,
  };
});
vi.mock(import("./SecretSourceInput"), () => ({
  useSecretSources: () => [],
  SecretSourceInput: (() => <input />) as never,
}));

import { SimlockDeviceHostEditor } from "./SimlockDeviceHostEditor";

describe("SimlockDeviceHostEditor", () => {
  it("leaves a cleared limit field empty and disables saving until a valid number is entered", async () => {
    const onSave = vi.fn();
    await using _screen = await render(
      <SimlockDeviceHostEditor
        host={{
          ...newSimlockDeviceHost("simlock"),
          gatewayUrl: "https://gateway.example.ts.net:4700",
        }}
        isNew={false}
        environments={[
          { environmentId: EnvironmentId.make("local"), label: "This Mac", hosts: [] },
        ]}
        busy={false}
        onSave={onSave}
        onClose={() => {}}
      />,
    );

    const saveButton = page.getByRole("button", { name: "Save host" });
    await expect.element(saveButton).not.toBeDisabled();

    const input = page.getByLabelText("Devices at once");
    await userEvent.clear(input);
    expect(input.element()).toHaveDisplayValue("");
    await expect.element(saveButton).toBeDisabled();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Keep the limits within the ranges shown.");

    await userEvent.type(input, "5");
    expect(input.element()).toHaveDisplayValue("5");
    await expect.element(saveButton).not.toBeDisabled();

    await userEvent.click(saveButton);
    expect(onSave).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        maxLeases: 5,
      }),
      expect.any(Map),
    );
  });
});
