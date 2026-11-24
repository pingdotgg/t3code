import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { converter } from "culori/fn";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import {
  ComposerEffortColumn,
  ComposerPickerFooter,
  describeComposerEffort,
} from "./ComposerModelEffort";
import type { TraitsSelectionInput } from "./TraitsPicker";

// Shaped like Devin over ACP: its session mode comes first, and its reasoning id is its own.
const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "fusion",
    name: "Fusion (Claude Opus 5.5 Medium + SWE-2 High)",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "mode",
          label: "Session Mode",
          type: "select",
          currentValue: "bypass",
          options: [
            { id: "code", label: "Code" },
            { id: "plan", label: "Plan" },
            { id: "bypass", label: "Bypass Permissions" },
          ],
        },
        {
          id: "thought_level",
          label: "Thinking",
          type: "select",
          role: "reasoning",
          currentValue: "medium",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
        {
          id: "speed",
          label: "Speed",
          type: "select",
          currentValue: "standard",
          options: [
            { id: "standard", label: "Standard" },
            { id: "fast", label: "Fast" },
          ],
        },
        { id: "auto_approve", label: "Auto-approve tools", type: "boolean", currentValue: false },
      ],
    }),
  },
];

function traitsInput(
  modelOptions: ReadonlyArray<ProviderOptionSelection>,
  onModelOptionsChange: (next: ReadonlyArray<ProviderOptionSelection> | undefined) => void,
): TraitsSelectionInput {
  return {
    provider: ProviderDriverKind.make("acpRegistry"),
    instanceId: ProviderInstanceId.make("devin"),
    models,
    model: "fusion",
    modelOptions,
    onModelOptionsChange,
  };
}

function Column() {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  const traits = traitsInput(options, (next) => setOptions(next ?? []));
  return (
    <>
      <div data-model-picker-effort>
        <ComposerEffortColumn traits={traits} />
      </div>
      <p role="status">{describeComposerEffort(traits, "bars", "sm").suffix}</p>
    </>
  );
}

it("draws an agent's reasoning as bars and keeps its mode out of the levels", async () => {
  await using screen = await render(<Column />, { router: false }); // no routes involved
  const status = screen.getByRole("status");
  expect(status.element().querySelector("[data-composer-effort-glyph]")).not.toBeNull();
  await expect.element(status).toHaveTextContent("");

  const levels = screen.getByRole("radiogroup", { name: "Thinking" });
  await expect.element(levels.getByRole("radio")).toHaveLength(3);
  await expect.element(screen.getByRole("radio", { name: "Plan" })).not.toBeInTheDocument();

  // Up and Down walk from the levels through the option rows without opening their menus.
  await userEvent.tab();
  await expect.element(screen.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  const speed = screen.getByRole("button", { name: "Speed: Standard" });
  await expect.element(speed).toHaveFocus();
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("menuitemradio", { name: "Standard" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await expect.element(speed).toHaveFocus();

  await userEvent.click(screen.getByText("Auto-approve tools"));
  await expect
    .element(screen.getByRole("switch", { name: "Auto-approve tools" }))
    .toHaveAttribute("aria-checked", "true");

  await userEvent.click(screen.getByRole("button", { name: "Session Mode: Bypass Permissions" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Plan" }));
  await expect
    .element(screen.getByRole("button", { name: "Session Mode: Plan" }))
    .toBeInTheDocument();
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
});

it("focuses a reasoning level by its first letter without selecting it", async () => {
  await using screen = await render(<Column />, { router: false }); // no routes involved
  await userEvent.tab();
  await expect.element(screen.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("l");
  await expect.element(screen.getByRole("radio", { name: "Low" })).toHaveFocus();
  await expect
    .element(screen.getByRole("radio", { name: "Medium" }))
    .toHaveAttribute("aria-checked", "true");
  for (const key of ["{Control>}h{/Control}", "{Meta>}h{/Meta}", "{Alt>}h{/Alt}", "{Delete}"]) {
    await userEvent.keyboard(key);
    await expect.element(screen.getByRole("radio", { name: "Low" })).toHaveFocus();
  }
  await userEvent.keyboard("H");
  await expect.element(screen.getByRole("radio", { name: "High" })).toHaveFocus();
  // Wraps past the last level back to the first match.
  await userEvent.keyboard("m");
  await expect.element(screen.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("h{Enter}");
  await expect
    .element(screen.getByRole("radio", { name: "High" }))
    .toHaveAttribute("aria-checked", "true");
});

const toRgb = converter("rgb");

type Rgb = readonly [number, number, number];

function compositeOver(cssColor: string, backdrop: Rgb): Rgb {
  const parsed = toRgb(cssColor);
  if (!parsed) return backdrop;
  const alpha = parsed.alpha ?? 1;
  return [
    parsed.r * alpha + backdrop[0] * (1 - alpha),
    parsed.g * alpha + backdrop[1] * (1 - alpha),
    parsed.b * alpha + backdrop[2] * (1 - alpha),
  ];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const linear = (channel: number) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function effectiveBackground(element: HTMLElement): Rgb {
  const chain: HTMLElement[] = [];
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    chain.push(current);
  }
  return chain
    .reverse()
    .reduce<Rgb>(
      (backdrop, node) => compositeOver(getComputedStyle(node).backgroundColor, backdrop),
      [0, 0, 0],
    );
}

const speedModels: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude",
    name: "Claude",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Speed", type: "boolean", currentValue: false }],
    }),
  },
];

function SpeedFooter(props: { darkPurple?: boolean }) {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  const traits: TraitsSelectionInput = {
    provider: ProviderDriverKind.make("claudeAgent"),
    instanceId: ProviderInstanceId.make("claude"),
    models: speedModels,
    model: "claude",
    modelOptions: options,
    onModelOptionsChange: (next) => setOptions(next ?? []),
  };
  return (
    <div
      className="bg-popover text-popover-foreground"
      style={
        props.darkPurple
          ? ({
              "--background": "#180f1b",
              "--popover": "#291d2f",
              "--muted": "#241929",
              "--border": "#3e2e45",
              "--input": "#4e3d57",
              "--foreground": "#f2eaf5",
              "--muted-foreground": "#b8a6bf",
            } as React.CSSProperties)
          : undefined
      }
    >
      <ComposerPickerFooter
        traits={traits}
        runtimeMode="full-access"
        runtimeModeOptions={[]}
        onRuntimeModeChange={() => {}}
      />
    </div>
  );
}

it.each([
  ["default dark", false],
  ["dark purple theme", true],
] as const)(
  "renders a clearly visible active state on the Standard / Fast selector in %s",
  async (_label, darkPurple) => {
    const root = document.documentElement;
    root.classList.add("dark");
    try {
      await using screen = await render(<SpeedFooter darkPurple={darkPurple} />, { router: false });
      const standard = screen.getByRole("radio", { name: "Standard" }).element() as HTMLElement;
      const fast = screen.getByRole("radio", { name: "Fast" }).element() as HTMLElement;

      const selectedBg = effectiveBackground(standard);
      const unselectedBg = effectiveBackground(fast);
      const selectedStyle = getComputedStyle(standard);
      const unselectedStyle = getComputedStyle(fast);
      const selectedBorder = compositeOver(selectedStyle.borderTopColor, unselectedBg);
      const selectedText = compositeOver(selectedStyle.color, selectedBg);

      expect(Number(selectedStyle.fontWeight)).toBeGreaterThan(Number(unselectedStyle.fontWeight));
      expect(Number.parseFloat(selectedStyle.borderTopWidth)).toBeGreaterThanOrEqual(1);
      expect(contrastRatio(selectedBg, unselectedBg)).toBeGreaterThanOrEqual(1.6);
      expect(contrastRatio(selectedBorder, unselectedBg)).toBeGreaterThanOrEqual(2.0);
      expect(contrastRatio(selectedText, selectedBg)).toBeGreaterThanOrEqual(7.0);

      await userEvent.click(screen.getByRole("radio", { name: "Fast" }));
      await expect
        .element(screen.getByRole("radio", { name: "Fast" }))
        .toHaveAttribute("aria-checked", "true");
      expect(
        contrastRatio(effectiveBackground(fast), effectiveBackground(standard)),
      ).toBeGreaterThanOrEqual(1.6);
    } finally {
      root.classList.remove("dark");
    }
  },
);

it("keeps the Standard / Fast active segment distinct and readable in light mode", async () => {
  document.documentElement.classList.remove("dark");
  await using screen = await render(<SpeedFooter />, { router: false });
  const standard = screen.getByRole("radio", { name: "Standard" }).element() as HTMLElement;
  const fast = screen.getByRole("radio", { name: "Fast" }).element() as HTMLElement;

  const selectedBg = effectiveBackground(standard);
  const unselectedBg = effectiveBackground(fast);
  const selectedStyle = getComputedStyle(standard);
  const unselectedStyle = getComputedStyle(fast);

  expect(relativeLuminance(selectedBg)).toBeGreaterThan(relativeLuminance(unselectedBg));
  expect(Number(selectedStyle.fontWeight)).toBeGreaterThan(Number(unselectedStyle.fontWeight));
  expect(Number.parseFloat(selectedStyle.borderTopWidth)).toBeGreaterThanOrEqual(1);
  expect(
    contrastRatio(compositeOver(selectedStyle.color, selectedBg), selectedBg),
  ).toBeGreaterThanOrEqual(7.0);
});
