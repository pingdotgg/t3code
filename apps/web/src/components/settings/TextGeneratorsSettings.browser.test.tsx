import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { act, render } from "../../../test/render";
import { TextGeneratorsSettings } from "./TextGeneratorsSettings";

const checkTextGeneratorConfig = vi.hoisted(() =>
  vi.fn<typeof import("../../textGenerators").checkTextGeneratorConfig>(async () => ({
    models: [{ id: "demo-model", name: "Demo model" }],
  })),
);

vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useEnvironmentSettings: () => ({
    ...DEFAULT_SERVER_SETTINGS,
    textGenerators: {
      local: {
        kind: "openaiCompatible",
        baseUrl: "http://localhost:1234/v1",
        apiKey: "",
        enabled: true,
      },
    },
  }),
  useUpdateEnvironmentSettings: () => () => {},
}));

vi.mock("../../textGenerators", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../textGenerators")>()),
  checkTextGeneratorConfig,
  useTextGeneratorModels: () =>
    AsyncResult.success(
      Array.from({ length: 9 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` })),
    ),
}));

it("clears the model search on Escape without closing the models dialog", async () => {
  await using _screen = await render(
    <TextGeneratorsSettings
      environmentId={EnvironmentId.make("local")}
      environmentLabel="This device"
      providers={[]}
      readOnly={false}
    />,
  );
  await userEvent.click(page.getByRole("button", { name: "More actions for localhost:1234" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Show models" }));
  const dialog = page.getByRole("dialog", { name: "localhost:1234 models" });
  const search = page.getByRole("searchbox", { name: "Search models" });
  await userEvent.fill(search, "model 1");
  for (const composition of [
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
  ]) {
    // Safari ends the composition just before the Escape keydown.
    await act(() => {
      search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      search
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { ...composition, bubbles: true }));
    });
    await expect.element(search).toHaveValue("model 1");
  }

  await userEvent.keyboard("{Escape}");
  await expect.element(search).toHaveValue("");
  await expect.element(search).toHaveFocus();
  await expect.element(search).toHaveAttribute("type", "text");
  // Holding Escape repeats the keydown, which must not also close the dialog.
  await act(() => {
    search
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true }));
  });
  await expect.element(dialog).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
});

it("submits step 1 of the text generator wizard on Enter when Connect is enabled", async () => {
  checkTextGeneratorConfig.mockClear();
  await using _screen = await render(
    <TextGeneratorsSettings
      environmentId={EnvironmentId.make("local")}
      environmentLabel="This device"
      providers={[]}
      readOnly={false}
    />,
  );
  await userEvent.click(page.getByRole("button", { name: "Add generator" }));
  await userEvent.click(page.getByRole("radio", { name: "Custom" }));

  const baseUrl = page.getByLabelText("Base URL");
  await expect.element(page.getByRole("button", { name: "Connect" })).toBeDisabled();
  await userEvent.click(baseUrl);
  await userEvent.keyboard("{Enter}");
  expect(checkTextGeneratorConfig).not.toHaveBeenCalled();

  await userEvent.type(baseUrl, "http://localhost:11434/v1{Enter}");
  expect(checkTextGeneratorConfig).toHaveBeenCalledOnce();
  await expect
    .element(page.getByText(/localhost:11434 is connected and lists 1 model\./))
    .toBeVisible();
});
