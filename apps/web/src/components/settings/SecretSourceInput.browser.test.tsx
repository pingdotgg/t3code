import { SecretProviderId, SecretProviderKind } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../test/render";
import { SecretSourceInput } from "./SecretSourceInput";

const personal = SecretProviderId.make("personal");
const work = SecretProviderId.make("work");
const sources = [
  { id: personal, kind: SecretProviderKind.make("one_password"), label: "Personal" },
  { id: work, kind: SecretProviderKind.make("one_password"), label: "Work" },
];

const reference = (screen: Screen) => screen.getByRole("textbox", { name: "API key reference" });

async function commitReference(screen: Screen, value: string) {
  await userEvent.clear(reference(screen));
  await userEvent.type(reference(screen), value);
  await userEvent.keyboard("{Enter}");
}

describe("SecretSourceInput", () => {
  it("moves a reference to another provider only once one is committed for it", async () => {
    const onSecretChange = vi.fn();
    await using screen = await render(
      <SecretSourceInput
        aria-label="API key"
        value={{ provider: personal, reference: "op://Private/OpenAI/credential" }}
        sources={sources}
        onCommit={() => {}}
        onSecretChange={onSecretChange}
      />,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "API key source" }));
    await userEvent.click(screen.getByRole("option", { name: "Work" }));
    expect(onSecretChange).not.toHaveBeenCalled();
    await expect.element(reference(screen)).toHaveValue("");

    await commitReference(screen, "op://Shared/OpenAI/credential");
    expect(onSecretChange).toHaveBeenCalledExactlyOnceWith({
      provider: work,
      reference: "op://Shared/OpenAI/credential",
    });
  });

  it("removes the reference when its field is cleared", async () => {
    const onSecretChange = vi.fn();
    await using screen = await render(
      <SecretSourceInput
        aria-label="API key"
        value={{ provider: personal, reference: "op://Private/OpenAI/credential" }}
        sources={sources}
        onCommit={() => {}}
        onSecretChange={onSecretChange}
      />,
    );

    await userEvent.clear(reference(screen));
    await userEvent.keyboard("{Enter}");
    expect(onSecretChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("rejects a reference 1Password cannot read", async () => {
    const onSecretChange = vi.fn();
    await using screen = await render(
      <SecretSourceInput
        aria-label="API key"
        value={{ provider: personal, reference: "op://Private/OpenAI/credential" }}
        sources={sources}
        onCommit={() => {}}
        onSecretChange={onSecretChange}
      />,
    );

    await commitReference(screen, "Private/OpenAI/credential");
    expect(onSecretChange).not.toHaveBeenCalled();
    await expect.element(reference(screen)).toHaveAttribute("aria-invalid", "true");
    await expect.element(reference(screen)).toHaveValue("Private/OpenAI/credential");
  });
});
