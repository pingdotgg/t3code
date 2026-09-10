import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type T3ProjectFileAutomation,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogClose: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("~/components/ui/button", () => ({
  Button: ({
    children,
    render,
    ...props
  }: {
    children?: ReactNode;
    render?: ReactNode;
    [key: string]: unknown;
  }) => (render ? <>{render}</> : <button {...props}>{children}</button>),
}));

vi.mock("~/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("~/components/ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}));

vi.mock("~/components/ui/switch", () => ({
  Switch: (props: Record<string, unknown>) => <input type="checkbox" {...props} />,
}));

vi.mock("~/components/ui/checkbox", () => ({
  Checkbox: (props: Record<string, unknown>) => <input type="checkbox" {...props} />,
}));

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProjectAutomationEditorDialog } from "./ProjectAutomationEditorDialog";

function createMockEntry(instanceId: string, driver: string) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [{ slug: "model-1", name: "Model One", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

describe("ProjectAutomationEditorDialog", () => {
  it("renders create automation dialog with trigger and action selectors", () => {
    const markup = renderToStaticMarkup(
      <ProjectAutomationEditorDialog
        open={true}
        onOpenChange={() => {}}
        automation={null}
        existingIds={[]}
        onSave={() => {}}
      />,
    );

    expect(markup).toContain("Add Automation");
    expect(markup).toContain("Trigger");
    expect(markup).toContain("Cron Schedule");
    expect(markup).toContain("GitHub PR");
    expect(markup).toContain("GitHub Issue");
    expect(markup).toContain("Action");
    expect(markup).toContain("Agent Thread");
    expect(markup).toContain("Run Script / Command");
    expect(markup).toContain("Create Automation");
  });

  it("renders model selection with inherited default text when creating a new automation", () => {
    const entry = createMockEntry("codex", "codex");
    const markup = renderToStaticMarkup(
      <ProjectAutomationEditorDialog
        open={true}
        onOpenChange={() => {}}
        automation={null}
        existingIds={[]}
        onSave={() => {}}
        instanceEntries={[entry]}
        defaultModelSelection={{
          instanceId: ProviderInstanceId.make("codex"),
          model: "model-1",
        }}
      />,
    );

    expect(markup).toContain("Model &amp; Provider");
    expect(markup).toContain("Inherits the project default model unless customized.");
    expect(markup).not.toContain("Reset to project default");
  });

  it("renders custom model selection and reset button when editing an automation with modelSelection", () => {
    const entry = createMockEntry("claude", "anthropic");
    const automation: T3ProjectFileAutomation = {
      id: "pr-bot",
      name: "PR Bot",
      enabled: true,
      trigger: {
        type: "github_pr",
        events: ["opened"],
      },
      action: {
        type: "thread",
        title: "Review PR",
        prompt: "Review PR",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-3-7-sonnet",
        },
      },
    };

    const markup = renderToStaticMarkup(
      <ProjectAutomationEditorDialog
        open={true}
        onOpenChange={() => {}}
        automation={automation}
        existingIds={[]}
        onSave={() => {}}
        instanceEntries={[entry]}
      />,
    );

    expect(markup).toContain("Edit Automation");
    expect(markup).toContain("Model &amp; Provider");
    expect(markup).toContain("Custom model configured for this automation.");
    expect(markup).toContain("Reset to project default");
  });
  it("renders job selection with built-in and project jobs", () => {
    const markup = renderToStaticMarkup(
      <ProjectAutomationEditorDialog
        open={true}
        onOpenChange={() => {}}
        automation={null}
        existingIds={[]}
        onSave={() => {}}
        projectJobs={[
          {
            id: "custom-tester",
            name: "Custom Tester",
            rolePrompt: "You test things.",
          },
        ]}
      />,
    );

    expect(markup).toContain("Agent Job / Role (optional)");
    expect(markup).toContain("Generic Agent (No specialized job)");
    expect(markup).toContain("Built-in Jobs");
    expect(markup).toContain("PR Reviewer");
    expect(markup).toContain("Pentester");
    expect(markup).toContain("Security Reviewer");
    expect(markup).toContain("Feature Refiner");
    expect(markup).toContain("Bug Triager");
    expect(markup).toContain("Project Jobs");
    expect(markup).toContain("Custom Tester");
  });
});
