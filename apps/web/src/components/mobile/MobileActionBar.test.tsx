import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../ProjectScriptsControl", () => ({
  __esModule: true,
  default: ({ surface }: { surface?: string }) => (
    <div data-testid="scripts-stub" data-surface={surface ?? ""} />
  ),
}));
vi.mock("../GitActionsControl", () => ({
  __esModule: true,
  default: ({ surface }: { surface?: string }) => (
    <div data-testid="git-stub" data-surface={surface ?? ""} />
  ),
}));
vi.mock("../ui/toggle", () => ({
  __esModule: true,
  Toggle: ({
    children,
    "aria-label": ariaLabel,
    pressed,
  }: {
    children?: React.ReactNode;
    "aria-label"?: string;
    pressed?: boolean;
  }) => (
    <button data-testid="toggle-stub" aria-label={ariaLabel} aria-pressed={pressed}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/tooltip", () => ({
  __esModule: true,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipPopup: () => null,
}));

import { MobileActionBar } from "./MobileActionBar";
import type { EnvironmentId, ProjectScript, ResolvedKeybindingsConfig, ThreadId } from "@t3tools/contracts";


const baseProps = {
  activeThreadEnvironmentId: "env-1" as EnvironmentId,
  activeThreadId: "thread-1" as ThreadId,
  activeProjectScripts: undefined,
  preferredScriptId: null,
  keybindings: {} as ResolvedKeybindingsConfig,
  onRunProjectScript: () => {},
  onAddProjectScript: async () => {},
  onUpdateProjectScript: async () => {},
  onDeleteProjectScript: async () => {},
  activeProjectName: undefined,
  gitCwd: null,
  isGitRepo: false,
  terminalAvailable: false,
  terminalOpen: false,
  terminalToggleShortcutLabel: null,
  onToggleTerminal: () => {},
  diffOpen: false,
  diffToggleShortcutLabel: null,
  onToggleDiff: () => {},
} as const;

describe("MobileActionBar", () => {
  it("renders no cells when no project, scripts, or git repo", () => {
    const markup = renderToStaticMarkup(<MobileActionBar {...baseProps} />);
    expect(markup).not.toContain('aria-label="Toggle terminal drawer"');
    expect(markup).not.toContain('aria-label="Toggle diff panel"');
    expect(markup).not.toContain('data-testid="scripts-stub"');
    expect(markup).not.toContain('data-testid="git-stub"');
    expect(markup).not.toContain('data-testid="open-in-stub"');
  });

  it("renders Diff cell when isGitRepo is true", () => {
    const markup = renderToStaticMarkup(<MobileActionBar {...baseProps} isGitRepo={true} />);
    expect(markup).toContain('aria-label="Toggle diff panel"');
  });

  it("renders Diff cell when diffOpen is true even without a git repo", () => {
    const markup = renderToStaticMarkup(<MobileActionBar {...baseProps} diffOpen={true} />);
    expect(markup).toContain('aria-label="Toggle diff panel"');
  });

  it("renders Terminal cell when terminalAvailable is true", () => {
    const markup = renderToStaticMarkup(
      <MobileActionBar {...baseProps} terminalAvailable={true} />,
    );
    expect(markup).toContain('aria-label="Toggle terminal drawer"');
  });

  it("renders Terminal cell when terminalOpen is true even if unavailable", () => {
    const markup = renderToStaticMarkup(
      <MobileActionBar {...baseProps} terminalOpen={true} />,
    );
    expect(markup).toContain('aria-label="Toggle terminal drawer"');
  });

  it("hides Terminal cell when neither available nor open", () => {
    const markup = renderToStaticMarkup(<MobileActionBar {...baseProps} />);
    expect(markup).not.toContain('aria-label="Toggle terminal drawer"');
  });

  it("renders Project Scripts cell when scripts array is provided", () => {
    const markup = renderToStaticMarkup(
      <MobileActionBar {...baseProps} activeProjectScripts={[] as ProjectScript[]} />,
    );
    expect(markup).toContain('data-testid="scripts-stub"');
    expect(markup).toContain('data-surface="segmented"');
  });

  it("never renders OpenInPicker cell", () => {
    const markup = renderToStaticMarkup(<MobileActionBar {...baseProps} />);
    expect(markup).not.toContain('data-testid="open-in-stub"');
  });

  it("renders Git cell when activeProjectName is set", () => {
    const markup = renderToStaticMarkup(
      <MobileActionBar {...baseProps} activeProjectName="my-project" />,
    );
    expect(markup).toContain('data-testid="git-stub"');
  });

  it("passes surface='segmented' to all customizable children", () => {
    const markup = renderToStaticMarkup(
      <MobileActionBar
        {...baseProps}
        activeProjectScripts={[] as ProjectScript[]}
        activeProjectName="proj"
      />,
    );
    const surfaceMatches = markup.match(/data-surface="segmented"/g) ?? [];
    expect(surfaceMatches.length).toBe(2);
  });

  it("marks Diff toggle as pressed when diffOpen is true", () => {
    const markup = renderToStaticMarkup(
      <MobileActionBar {...baseProps} isGitRepo={true} diffOpen={true} />,
    );
    const match = markup.match(/aria-label="Toggle diff panel"[^>]*aria-pressed="([^"]+)"/);
    expect(match?.[1]).toBe("true");
  });

  it("declares the segmented container with data-swipe-ignore", () => {
    const markup = renderToStaticMarkup(<MobileActionBar {...baseProps} />);
    expect(markup).toContain('data-swipe-ignore="true"');
  });
});
