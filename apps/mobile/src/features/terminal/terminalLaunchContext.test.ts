import * as NodeModule from "node:module";
import { act, createElement, useEffect, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  resolvePreferredThreadWorktreePath,
  resolveTerminalOpenLocation,
  stagePendingTerminalLaunch,
  takePendingTerminalLaunch,
  useInitialTerminalLaunchLocation,
} from "./terminalLaunchContext";

describe("resolvePreferredThreadWorktreePath", () => {
  it("prefers thread detail worktree paths over thread shell paths", () => {
    expect(
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: "/repo/root",
        threadDetailWorktreePath: "/repo/worktrees/feature",
      }),
    ).toBe("/repo/worktrees/feature");
  });

  it("falls back to the thread shell worktree path when detail is unavailable", () => {
    expect(
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: "/repo/worktrees/feature",
        threadDetailWorktreePath: null,
      }),
    ).toBe("/repo/worktrees/feature");
  });
});

describe("resolveTerminalOpenLocation", () => {
  it("uses the thread detail worktree path before the workspace root for a fresh mobile open", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: null,
        workspaceRoot: "/repo/root",
        threadShellWorktreePath: null,
        threadDetailWorktreePath: "/repo/worktrees/feature",
      }),
    ).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
    });
  });

  it("preserves the running terminal snapshot cwd when attaching to an existing session", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: {
          cwd: "/repo/worktrees/feature",
          worktreePath: "/repo/worktrees/feature",
        },
        workspaceRoot: "/repo/root",
        threadShellWorktreePath: null,
        threadDetailWorktreePath: "/repo/worktrees/other",
      }),
    ).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
    });
  });

  it("preserves checkout cwd and identity from the selected terminal or active session", () => {
    const checkout = { cwd: "/repo/root/packages/app", worktreePath: null };
    const threadLocation = {
      workspaceRoot: "/repo/root",
      threadShellWorktreePath: "/repo/worktrees/feature",
      threadDetailWorktreePath: "/repo/worktrees/feature",
    };

    expect(
      resolveTerminalOpenLocation({
        ...threadLocation,
        terminalLocation: checkout,
        activeSessionLocation: {
          cwd: "/repo/worktrees/other",
          worktreePath: "/repo/worktrees/other",
        },
      }),
    ).toEqual(checkout);

    expect(
      resolveTerminalOpenLocation({
        ...threadLocation,
        terminalLocation: null,
        activeSessionLocation: checkout,
      }),
    ).toEqual(checkout);
  });
});

describe("pending terminal launches", () => {
  it("stages and consumes launch details for a specific terminal target", () => {
    const target = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-2",
    };

    stagePendingTerminalLaunch({
      target,
      launch: {
        cwd: "/repo/worktrees/feature",
        worktreePath: "/repo/worktrees/feature",
        env: { FOO: "bar" },
        initialInput: "pnpm dev\r",
      },
    });

    expect(takePendingTerminalLaunch(target)).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
      env: { FOO: "bar" },
      initialInput: "pnpm dev\r",
    });
    expect(takePendingTerminalLaunch(target)).toBeNull();
  });

  it("keeps pending launches isolated per terminal target", () => {
    const primaryTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-2",
    };
    const otherTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-3",
    };

    stagePendingTerminalLaunch({
      target: primaryTarget,
      launch: {
        cwd: "/repo/root",
        worktreePath: null,
        initialInput: "pnpm i\r",
      },
    });

    expect(takePendingTerminalLaunch(otherTarget)).toBeNull();
    expect(takePendingTerminalLaunch(primaryTarget)).toEqual({
      cwd: "/repo/root",
      worktreePath: null,
      env: undefined,
      initialInput: "pnpm i\r",
    });
  });
});

describe("initial terminal launch location", () => {
  it("waits for session metadata before retaining a location for each route target", async () => {
    const { createRoot } = NodeModule.createRequire(import.meta.url)("react-dom/client") as {
      createRoot(container: Element): {
        render(children: ReactNode): void;
        unmount(): void;
      };
    };
    const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
    const container = {
      nodeType: 1,
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(container as unknown as HTMLElement);
    type Input = Parameters<typeof useInitialTerminalLaunchLocation>[0];
    let location: ReturnType<typeof useInitialTerminalLaunchLocation> = null;
    function Probe(input: Input) {
      const selectedLocation = useInitialTerminalLaunchLocation(input);
      useEffect(() => {
        location = selectedLocation;
      }, [selectedLocation]);
      return null;
    }
    const threadLocation = {
      terminalLocation: null,
      activeSessionLocation: null,
      workspaceRoot: "/repo/root",
      threadShellWorktreePath: "/repo/worktrees/feature",
      threadDetailWorktreePath: "/repo/worktrees/feature",
    };
    const checkout = { cwd: "/repo/root/packages/app", worktreePath: null };
    const input: Input = {
      targetKey: "environment:thread:term-1",
      pendingLaunch: null,
      hasResolvedPendingLaunch: true,
      isAuthenticated: true,
      canRead: true,
      canOperate: true,
      hasLoadedSessions: false,
      location: threadLocation,
    };
    const render = (changes: Partial<Input> = {}) =>
      act(() => root.render(createElement(Probe, { ...input, ...changes })));
    try {
      // Thread/project are ready before authentication and the metadata snapshot.
      await render({ isAuthenticated: false, canRead: false, canOperate: false });
      expect(location).toBeNull();
      await render();
      expect(location).toBeNull();
      await render({
        hasLoadedSessions: true,
        canOperate: false,
        location: { ...threadLocation, terminalLocation: checkout },
      });
      expect(location).toEqual(checkout);

      // Reconnects and subsequent thread changes must not move the selected terminal.
      await render({ location: { ...threadLocation, threadDetailWorktreePath: "/repo/other" } });
      expect(location).toEqual(checkout);

      const nextTarget = { targetKey: "environment:thread:term-2" };
      await render(nextTarget);
      expect(location).toBeNull();
      // A loaded empty session list permits the fresh-open thread fallback.
      await render({ ...nextTarget, hasLoadedSessions: true });
      expect(location).toEqual({
        cwd: "/repo/worktrees/feature",
        worktreePath: "/repo/worktrees/feature",
      });

      await render({ targetKey: "environment:thread:term-3", hasResolvedPendingLaunch: false });
      expect(location).toBeNull();
      await render({ targetKey: "environment:thread:term-3", pendingLaunch: checkout });
      expect(location).toEqual(checkout);

      // Operate-only grants cannot load metadata, so they still use the thread default.
      await render({ targetKey: "environment:thread:term-4", canRead: false });
      expect(location).toEqual({
        cwd: "/repo/worktrees/feature",
        worktreePath: "/repo/worktrees/feature",
      });
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
