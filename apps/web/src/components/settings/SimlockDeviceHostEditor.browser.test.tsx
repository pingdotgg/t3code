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
  it("leaves a cleared limit field empty and keeps Save off until a number is entered", async () => {
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
        onSave={() => {}}
        onClose={() => {}}
      />,
    );

    const saveButton = page.getByRole("button", { name: "Save host" });
    await expect.element(saveButton).not.toBeDisabled();

    const input = page.getByLabelText("Devices at once");
    await userEvent.clear(input);
    await expect.element(input).toHaveDisplayValue("");
    await expect.element(saveButton).toBeDisabled();

    await userEvent.type(input, "5");
    await expect.element(input).toHaveDisplayValue("5");
    await expect.element(saveButton).not.toBeDisabled();
  });
});
