import { act, render } from "../../../test/render";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { SideChatControls } from "./SideChatControls";
import { SideChatContext } from "./SideChatPanel";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { TraitsPicker, readPromptUltrathink } from "./TraitsPicker";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const models: ServerProviderModel[] = ["first-model", "second-model"].map((slug) => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning effort",
        type: "select",
        currentValue: "high",
        options: [
          { id: "high", label: "High" },
          { id: "low", label: "Low" },
        ],
      },
    ],
  },
}));
const entries = deriveProviderInstanceEntries([
  {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-15T00:00:00Z",
    models,
    slashCommands: [],
    skills: [],
  },
]);
function Fixture({ active = true }: { active?: boolean }) {
  const [draft, setDraft] = useState("unsent side question");
  const [model, setModel] = useState(models[0]!.slug);
  const [options, setOptions] = useState([{ id: "reasoningEffort", value: "high" }]);
  return (
    <>
      <textarea aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <SideChatContext visible={active} />
      <SideChatControls active={active}>
        <ProviderModelPicker
          environmentId={null}
          lockedProvider={null}
          activeInstanceId={instanceId}
          model={model}
          instanceEntries={entries}
          modelOptionsByInstance={new Map([[instanceId, models]])}
          triggerAriaLabel="Side chat model"
          onInstanceModelChange={(_, next) => setModel(next)}
        />
        <TraitsPicker
          provider={driver}
          instanceId={instanceId}
          model={model}
          models={models}
          modelOptions={options}
          promptUltrathink={readPromptUltrathink(draft)}
          onPromptEdit={setDraft}
          planModeEnabled={false}
          onModelOptionsChange={(next) =>
            setOptions((next ?? []).map((o) => ({ id: o.id, value: String(o.value) })))
          }
        />
      </SideChatControls>
    </>
  );
}
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  );
  expect(result, `button ${label}`).toBeDefined();
  return result!;
}
async function click(label: string) {
  await act(() => button(label).click());
}
it("shows the model and reasoning in the footer and changes reasoning without losing the draft", async () => {
  await using screen = await render(<Fixture />);
  const container = screen.container;
  expect(document.body.textContent).toContain("High");
  expect(document.body.textContent).toContain("first-model");
  await click("High");
  const low = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((e) =>
    e.textContent?.includes("Low"),
  );
  expect(low).toBeDefined();
  await act(() => low!.click());
  expect(button("Low")).toBeDefined();
  expect(container.querySelector("textarea")?.value).toBe("unsent side question");
});
it("closes portaled controls when its tab hides and does not reopen them on return", async () => {
  await using screen = await render(<Fixture />);
  const container = screen.container;
  expect(document.body.textContent).toContain("first-model");
  await click("High");
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await screen.rerender(<Fixture active={false} />);
  expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await screen.rerender(<Fixture />);
  expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
  expect(container.querySelector("textarea")?.value).toBe("unsent side question");
});

it("hides frozen-context help with its panel without reopening it on return", async () => {
  await using screen = await render(<Fixture />);
  await click("Side chat context");
  expect(document.body.textContent).toContain("Each side chat uses the main conversation");
  await screen.rerender(<Fixture active={false} />);
  await vi.waitFor(() =>
    expect(document.body.textContent).not.toContain("Each side chat uses the main conversation"),
  );
  await screen.rerender(<Fixture />);
  expect(document.body.textContent).not.toContain("Each side chat uses the main conversation");
});
