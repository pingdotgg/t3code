// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { WizardSteps } from "./wizard";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("preserves focus and step identity when translated labels change or coincide", async () => {
  await act(async () =>
    root.render(
      <WizardSteps
        steps={["Connect", "Agents", "Projects"]}
        currentStep={1}
        onStepChange={() => {}}
      />,
    ),
  );
  const buttons = [...container.querySelectorAll("button")];
  buttons[0]!.focus();
  await act(async () =>
    root.render(
      <WizardSteps
        steps={["设置", "设置", "项目"]}
        currentStep={1}
        onStepChange={() => {}}
        accessibleLabel="设置进度"
        getStepAccessibleLabel={(name, index) => `${name}，第 ${index + 1} 步`}
      />,
    ),
  );
  const translatedButtons = [...container.querySelectorAll("button")];
  expect(translatedButtons[0]).toBe(buttons[0]);
  expect(translatedButtons[1]).toBe(buttons[1]);
  expect(translatedButtons[2]).toBe(buttons[2]);
  expect(document.activeElement).toBe(buttons[0]);
  expect(container.querySelector("ol")?.getAttribute("aria-label")).toBe("设置进度");
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
    "设置，第 1 步",
    "设置，第 2 步",
    "项目，第 3 步",
  ]);
  expect(buttons[1]?.getAttribute("aria-current")).toBe("step");
});

it("retains completed summaries in both default and localized accessible labels", async () => {
  await act(async () =>
    root.render(
      <WizardSteps
        steps={["Connect", "Agents"]}
        summaries={["Two computers", "Not completed"]}
        currentStep={1}
      />,
    ),
  );
  expect(container.querySelectorAll("li > div")[0]?.getAttribute("aria-label")).toBe(
    "Connect, step 1, Two computers",
  );
  await act(async () =>
    root.render(
      <WizardSteps
        steps={["连接", "代理"]}
        summaries={["两台电脑", "尚未完成"]}
        currentStep={1}
        getStepAccessibleLabel={(name, index, summary) =>
          `${name}，第 ${index + 1} 步${summary ? `，${summary}` : ""}`
        }
      />,
    ),
  );
  const steps = container.querySelectorAll("li > div");
  expect(steps[0]?.getAttribute("aria-label")).toBe("连接，第 1 步，两台电脑");
  expect(steps[1]?.getAttribute("aria-label")).toBe("代理，第 2 步");
});
