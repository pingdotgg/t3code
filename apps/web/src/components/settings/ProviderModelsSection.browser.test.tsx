import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { type ComponentProps, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { act, render } from "../../../test/render";
import { AppRouteModal } from "../AppRouteModal";
import { ProviderModelsSection } from "./ProviderModelsSection";

vi.mock("../chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));

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

const models: ServerProviderModel[] = ["a", "b", "c", "d", "e"].map((id) => ({
  slug: `model-${id}`,
  name: `Model ${id.toUpperCase()}`,
  isCustom: false,
  capabilities: null,
}));

function StatefulModelsSection() {
  const [hiddenModels, setHiddenModels] = useState<ReadonlyArray<string>>(
    models.map((model) => model.slug),
  );
  return section({ models, hiddenModels, onHiddenModelsChange: setHiddenModels });
}

const rowSlugs = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-model-slug]"), (row) =>
    row.getAttribute("data-model-slug"),
  );

it("keeps a model in place when it is shown again after disabling all", async () => {
  await using screen = await render(<StatefulModelsSection />);
  const order = models.map((model) => model.slug);
  expect(rowSlugs(screen.container)).toEqual(order);

  const toggle = screen.getByRole("switch", { name: "Show Model C in the model picker" });
  await toggle.click();
  await expect.element(toggle).toBeChecked();

  expect(rowSlugs(screen.container)).toEqual(order);
});

it("regroups the list when all models are disabled and enabled again", async () => {
  await using screen = await render(<StatefulModelsSection />);
  const toggle = screen.getByRole("switch", { name: "Show Model C in the model picker" });
  await toggle.click();
  await expect.element(toggle).toBeChecked();

  await screen.getByRole("button", { name: "Disable all" }).click();
  await screen.getByRole("button", { name: "Enable all" }).click();
  await expect.element(toggle).toBeChecked();

  expect(rowSlugs(screen.container)).toEqual(models.map((model) => model.slug));
});

it("cancels adding or editing a custom model on Escape without closing Settings", async () => {
  const kept = { slug: "kept-model", name: "kept-model", capabilities: null };
  await using _screen = await render(
    <AppRouteModal label="Settings">
      {section({ models: [{ ...kept, isCustom: true }], customModels: [kept] })}
    </AppRouteModal>,
    { router: "/settings/providers" },
  );
  const settings = page.getByRole("dialog", { name: "Settings" });

  await userEvent.click(page.getByRole("button", { name: "Add custom model" }));
  const addInput = page.getByRole("textbox");
  await userEvent.type(addInput, "draft-model");
  await userEvent.keyboard("{Escape}");
  await expect.element(addInput).not.toBeInTheDocument();
  await expect.element(settings).toHaveAttribute("data-open");

  await userEvent.click(page.getByRole("button", { name: "Edit kept-model", exact: true }));
  const displayName = page.getByRole("textbox", { name: "Display name", exact: true });
  await userEvent.click(displayName);
  await expect.element(displayName).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(displayName).not.toBeInTheDocument();
  await expect.element(settings).toHaveAttribute("data-open");

  await userEvent.keyboard("{Escape}");
  await expect.element(settings).not.toBeInTheDocument();
});

it("clears the model filter on Escape without closing Settings", async () => {
  const manyModels = Array.from({ length: 9 }, (_, index) => ({
    slug: `gpt-${index}`,
    name: `GPT ${index}`,
    isCustom: false,
    capabilities: null,
  }));
  await using _screen = await render(
    <AppRouteModal label="Settings">{section({ models: manyModels })}</AppRouteModal>,
    { router: "/settings/providers" },
  );
  const settings = page.getByRole("dialog", { name: "Settings" });
  const filter = page.getByRole("textbox", { name: "Filter models" });
  await userEvent.type(filter, "gpt 1");
  for (const composition of [
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
  ]) {
    // Safari ends the composition just before the Escape keydown.
    await act(() => {
      filter.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      filter
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { ...composition, bubbles: true }));
    });
    await expect.element(filter).toHaveValue("gpt 1");
  }

  await userEvent.keyboard("{Escape}");
  await expect.element(filter).toHaveValue("");
  await expect.element(filter).toHaveFocus();
  // Holding Escape repeats the keydown, which must not also close Settings.
  await act(() => {
    filter
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true }));
  });
  await expect.element(settings).toHaveAttribute("data-open");

  await userEvent.keyboard("{Escape}");
  await expect.element(settings).not.toBeInTheDocument();
});
