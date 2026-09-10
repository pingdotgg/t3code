import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type T3ProjectFileAutomation,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...props }: { readonly children?: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("~/components/ui/switch", () => ({
  Switch: (props: Record<string, unknown>) => <input type="checkbox" {...props} />,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProjectAutomationsSection } from "./ProjectAutomationsSection";

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
    models: [{ slug: "test-model", name: "Test Model", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

describe("ProjectAutomationsSection", () => {
  it("renders empty state when there are no automations", () => {
    const markup = renderToStaticMarkup(
      <ProjectAutomationsSection
        environmentId={"env-local" as any}
        workspaceRoot="/workspace"
        t3File={{
          status: "valid",
          file: { automations: [] },
          scripts: [],
          automations: [],
          jobs: [],
          rawContents: "{}",
        }}
      />,
    );

    expect(markup).toContain("Automations");
    expect(markup).toContain("No automations configured");
    expect(markup).toContain("Add automation");
  });

  it("renders warning when t3.json is invalid", () => {
    const markup = renderToStaticMarkup(
      <ProjectAutomationsSection
        environmentId={"env-local" as any}
        workspaceRoot="/workspace"
        t3File={{
          status: "invalid",
          file: null,
          scripts: [],
          automations: [],
          jobs: [],
          rawContents: "{ broken",
        }}
      />,
    );

    expect(markup).toContain("t3.json is invalid");
  });

  it("renders list of configured automations", () => {
    const sampleAutomations: T3ProjectFileAutomation[] = [
      {
        id: "daily-ci",
        name: "Daily CI Checks",
        enabled: true,
        trigger: {
          type: "cron",
          schedule: "0 0 * * *",
        },
        action: {
          type: "script",
          command: "npm test",
        },
      },
      {
        id: "pr-review",
        name: "Auto PR Reviewer",
        enabled: true,
        trigger: {
          type: "github_pr",
          events: ["opened", "synchronize"],
        },
        action: {
          type: "thread",
          title: "Review PR #${pr.number}",
          prompt: "Please review PR #${pr.number}: ${pr.title}",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5",
          },
        },
      },
      {
        id: "issue-triage",
        name: "Issue Triage",
        enabled: false,
        trigger: {
          type: "github_issue",
          events: ["opened", "labeled"],
          labels: ["bug"],
        },
        action: {
          type: "thread",
          prompt: "Analyze issue #${issue.number}",
        },
      },
    ];

    const markup = renderToStaticMarkup(
      <ProjectAutomationsSection
        environmentId={"env-local" as any}
        workspaceRoot="/workspace"
        instanceEntries={[createMockEntry("codex", "codex")]}
        t3File={{
          status: "valid",
          file: { automations: sampleAutomations },
          scripts: [],
          automations: sampleAutomations,
          jobs: [],
          rawContents: JSON.stringify({ automations: sampleAutomations }),
        }}
      />,
    );

    expect(markup).toContain("Daily CI Checks");
    expect(markup).toContain("cron: 0 0 * * *");
    expect(markup).toContain("Run: npm test");

    expect(markup).toContain("Auto PR Reviewer");
    expect(markup).toContain("pr: opened, synchronize");
    expect(markup).toContain("Thread: Review PR #${pr.number}");
    expect(markup).toContain("codex: gpt-5");

    expect(markup).toContain("Issue Triage");
    expect(markup).toContain("issue: opened, labeled");
    expect(markup).toContain("Thread prompt: Analyze issue #${issue.number}");
  });
});
