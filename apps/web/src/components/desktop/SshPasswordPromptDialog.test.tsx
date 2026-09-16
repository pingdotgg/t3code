import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import { act } from "react";
import type { ReactNode } from "react";
import { create } from "react-test-renderer";
import type { ReactTestRenderer, ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Base UI owns browser portals and focus management; use host elements in the
// non-DOM renderer while exercising the real prompt state and user-facing copy.
vi.mock("@base-ui/react/dialog", () => ({
  Dialog: {
    createHandle: () => ({}),
    Root: ({ children }: { children: ReactNode }) => children,
    Portal: ({ children }: { children: ReactNode }) => children,
    Backdrop: "div",
    Viewport: "div",
    Popup: "section",
    Title: "h2",
    Description: "p",
  },
}));

import { SshPasswordPromptDialog } from "./SshPasswordPromptDialog";

function visibleText(
  node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null,
): string {
  if (typeof node === "string") return node;
  if (node === null) return "";
  return (Array.isArray(node) ? node : (node.children ?? [])).map(visibleText).join("");
}

describe("SshPasswordPromptDialog verification copy", () => {
  let renderer: ReactTestRenderer;
  let receivePrompt: (request: DesktopSshPasswordPromptRequest) => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", {
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => undefined,
      setInterval,
      clearInterval,
      desktopBridge: {
        onSshPasswordPrompt: (listener: typeof receivePrompt) => {
          receivePrompt = listener;
          return () => undefined;
        },
      },
    });
    await act(async () => {
      renderer = create(<SshPasswordPromptDialog />);
    });
  });

  afterEach(async () => {
    await act(async () => renderer.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function openPrompt() {
    await act(async () => {
      receivePrompt({
        requestId: "ssh-verification-test",
        destination: "devbox",
        username: "julius",
        prompt: "Enter the SSH password or verification code for julius@devbox.",
        expiresAt: "2026-09-09T00:01:00Z",
      });
    });
  }

  it("explains password and verification code authentication without promising keys bypass 2FA", async () => {
    await openPrompt();
    const text = visibleText(renderer.toJSON());
    expect(text).toContain("SSH verification required");
    expect(text).toContain("Enter the password or verification code required by julius@devbox.");
    expect(text).toContain(
      "SSH keys may replace a password, but your server can still require a verification code.",
    );
  });

  it("describes an expired verification request without calling it a password prompt", async () => {
    await openPrompt();
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(visibleText(renderer.toJSON())).toContain(
      "This SSH verification prompt expired. Try connecting again.",
    );
  });
});
