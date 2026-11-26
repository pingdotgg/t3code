import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { newEasDeviceHost } from "./easDeviceHostsSettings.logic";

vi.mock(import("../../state/device"), async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const accountAtom = Atom.make(AsyncResult.initial());
  return {
    deviceEasAccountCheck: (() => accountAtom) as never,
    deviceEnvironment: { easAccount: { label: "easAccount" } } as never,
  };
});
vi.mock(import("./SecretSourceInput"), () => ({
  useSecretSources: () => [],
  SecretSourceInput: (() => <input />) as never,
}));

import { EasDeviceHostEditor } from "./EasDeviceHostEditor";

describe("EasDeviceHostEditor", () => {
  it("leaves a cleared limit field empty and keeps Save off until a number is entered", async () => {
    await using _screen = await render(
      <EasDeviceHostEditor
        environmentId={EnvironmentId.make("local")}
        host={newEasDeviceHost("eas")}
        isNew
        busy={false}
        onSave={() => {}}
        onClose={() => {}}
      />,
    );

    const saveButton = page.getByRole("button", { name: "Save host" });
    await expect.element(saveButton).not.toBeDisabled();

    const input = page.getByLabelText("Sessions at once");
    await userEvent.clear(input);
    await expect.element(input).toHaveDisplayValue("");
    await expect.element(saveButton).toBeDisabled();

    await userEvent.type(input, "5");
    await expect.element(input).toHaveDisplayValue("5");
    await expect.element(saveButton).not.toBeDisabled();
  });
});
