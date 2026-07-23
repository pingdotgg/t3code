import { Children, isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { ADD_PROVIDER_WIZARD_STEPS } from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";

interface StepButtonProps {
  readonly "aria-current"?: string;
  readonly onClick: () => void;
}

interface StepListItemProps {
  readonly children: ReactElement<StepButtonProps>;
}

function renderStepButtons(
  currentStep: number,
  instanceIdError: string | null,
  onNavigation: Parameters<typeof AddProviderInstanceWizardSteps>[0]["onNavigation"],
): ReactElement<StepButtonProps>[] {
  const header = AddProviderInstanceWizardSteps({
    currentStep,
    summaries: ["Codex", "Codex Workspace", null],
    instanceIdError,
    onNavigation,
  });

  return Children.toArray(header.props.children)
    .filter((child): child is ReactElement<StepListItemProps> => isValidElement(child))
    .map((item) => item.props.children);
}

describe("AddProviderInstanceWizardSteps", () => {
  it("gates the actual Config header click through Identity validation", () => {
    const onNavigation = vi.fn();
    const buttons = renderStepButtons(0, "Instance ID is required.", onNavigation);

    expect(buttons).toHaveLength(ADD_PROVIDER_WIZARD_STEPS.length);
    buttons[2]!.props.onClick();

    expect(onNavigation).toHaveBeenCalledOnce();
    expect(onNavigation).toHaveBeenCalledWith({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("marks the wizard step separately from the clicked button focus", () => {
    const buttons = renderStepButtons(1, "Instance ID is required.", vi.fn());

    expect(buttons[0]!.props["aria-current"]).toBeUndefined();
    expect(buttons[1]!.props["aria-current"]).toBe("step");
    expect(buttons[2]!.props["aria-current"]).toBeUndefined();
  });

  it("preserves the actual backward header click", () => {
    const onNavigation = vi.fn();
    const buttons = renderStepButtons(2, "Instance ID is required.", onNavigation);

    buttons[0]!.props.onClick();

    expect(onNavigation).toHaveBeenCalledWith({ kind: "navigate", step: 0 });
  });
});
