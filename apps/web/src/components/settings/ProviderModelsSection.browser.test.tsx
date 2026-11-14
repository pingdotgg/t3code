import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { ProviderModelsSection } from "./ProviderModelsSection";

function section(props: Partial<ComponentProps<typeof ProviderModelsSection>>) {
  return (
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("claude")}
      driverKind={ProviderDriverKind.make("claude")}
      models={[]}
      customModels={[]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={async () => true}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
      {...props}
    />
  );
}

it("lists a favorite the provider no longer reports so it can be unstarred", async () => {
  const onToggleFavorite = vi.fn();
  await using screen = await render(
    section({ favoriteModels: ["retired-model"], onToggleFavorite }),
  );
  await screen.getByRole("button", { name: "Remove retired-model from favorites" }).click();
  expect(onToggleFavorite).toHaveBeenCalledWith("retired-model");
});

it("keeps custom model drafts until they save, so a failed save can be retried", async () => {
  const saves: Array<(saved: boolean) => void> = [];
  const onChange = () => new Promise<boolean>((resolve) => saves.push(resolve));
  const kept = { slug: "kept-model", name: "kept-model", capabilities: null };
  await using screen = await render(
    section({ onChange, models: [{ ...kept, isCustom: true }], customModels: [kept] }),
  );
  const addCustomModel = screen.getByRole("button", { name: "Add custom model" });
  const input = screen.getByRole("textbox");
  const add = screen.getByRole("button", { name: "Add", exact: true });

  await userEvent.click(addCustomModel);
  await userEvent.type(input, "my-model{Enter}");
  await expect.element(add).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  expect(saves).toHaveLength(1);
  await act(() => saves[0]!(false));
  await expect.element(add).toBeEnabled();
  await expect.element(input).toHaveValue("my-model");

  await userEvent.click(add);
  await act(() => saves[1]!(true));
  await expect.element(input).not.toBeInTheDocument();

  // A save the user cancelled must not close the draft opened after it.
  await userEvent.click(addCustomModel);
  await userEvent.type(input, "other-model{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(addCustomModel);
  await act(() => saves[2]!(true));
  await expect.element(add).toBeEnabled();

  await userEvent.click(screen.getByRole("button", { name: "Edit kept-model", exact: true }));
  const displayName = screen.getByRole("textbox", { name: "Display name", exact: true });
  await userEvent.fill(displayName, "Renamed");
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await act(() => saves[3]!(false));
  await expect.element(displayName).toHaveValue("Renamed");
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await act(() => saves[4]!(true));
  await expect.element(displayName).not.toBeInTheDocument();
});

it("keeps changes typed while an earlier save succeeds", async () => {
  const saves: Array<(saved: boolean) => void> = [];
  const onChange = () => new Promise<boolean>((resolve) => saves.push(resolve));
  const kept = { slug: "kept-model", name: "kept-model", capabilities: null };
  await using screen = await render(
    section({ onChange, models: [{ ...kept, isCustom: true }], customModels: [kept] }),
  );
  await screen.getByRole("button", { name: "Edit kept-model", exact: true }).click();
  const displayName = screen.getByRole("textbox", { name: "Display name", exact: true });
  const save = screen.getByRole("button", { name: "Save", exact: true });
  await userEvent.fill(displayName, "Submitted draft");
  await save.click();
  await userEvent.fill(displayName, "New draft");
  await act(() => saves[0]!(true));
  await expect.element(displayName).toHaveValue("New draft");
  await save.click();
  await act(() => saves[1]!(true));
  await expect.element(displayName).not.toBeInTheDocument();
});
