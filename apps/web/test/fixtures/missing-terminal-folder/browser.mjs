import { runAtomCommand } from "../../../../../packages/client-runtime/src/state/runtime";
import { appAtomRegistry } from "../../../src/rpc/atomRegistry";
import { projectEnvironment } from "../../../src/state/projects";
import { threadEnvironment } from "../../../src/state/threads";
import { terminalEnvironment } from "../../../src/state/terminal";
import { readProjects, readThreadShell, readThreadShells } from "../../../src/state/entities";
import { useTerminalUiStateStore } from "../../../src/terminalUiStateStore";
import { useRightPanelStore } from "../../../src/rightPanelStore";
import fixture from "./fixture.json";

async function command(atom, environmentId, input) {
  const result = await runAtomCommand(appAtomRegistry, atom, { environmentId, input });
  if (result._tag !== "Success") throw new Error(`Fixture command failed: ${atom.label}`);
  return result.value;
}

// Run in an authenticated, disposable development browser; no provider turn is started.
export async function seed(environmentId, sourceThreadId) {
  const source = readThreadShell({ environmentId, threadId: sourceThreadId });
  if (!source)
    throw new Error("A persisted source thread is required to inherit its model and modes.");
  const project = readProjects().find(
    (item) => item.environmentId === environmentId && item.id === fixture.projectId,
  );
  if (project && project.workspaceRoot !== fixture.projectPath)
    throw new Error("Fixture project ID belongs to another path.");
  if (!project) {
    await command(projectEnvironment.create, environmentId, {
      projectId: fixture.projectId,
      title: "Terminal folder fixture",
      workspaceRoot: fixture.projectPath,
      createWorkspaceRootIfMissing: false,
      defaultModelSelection: source.modelSelection,
    });
  }
  for (const [threadId, title, worktreePath] of [
    [fixture.threadId, "Missing folder lifecycle", null],
    [fixture.awayThreadId, "Stopped switch-away fixture", null],
    [fixture.longThreadId, "Long path layout fixture", fixture.longPath],
  ]) {
    if (
      !readThreadShells().some(
        (item) => item.environmentId === environmentId && item.id === threadId,
      )
    ) {
      await command(threadEnvironment.create, environmentId, {
        threadId,
        projectId: fixture.projectId,
        title,
        worktreePath,
        modelSelection: source.modelSelection,
        runtimeMode: source.runtimeMode,
        interactionMode: source.interactionMode,
        branch: null,
      });
    }
  }
  return { ...fixture, environmentId };
}

export async function reset(environmentId, threadId = fixture.threadId) {
  if (![fixture.threadId, fixture.awayThreadId, fixture.longThreadId].includes(threadId)) {
    throw new Error("Refusing to reset a non-fixture thread.");
  }
  const ref = { environmentId, threadId };
  const panels = useRightPanelStore.getState();
  const drawer = useTerminalUiStateStore.getState();
  const key = `${environmentId}:${threadId}`;
  const ids = new Set([
    ...(drawer.terminalUiStateByThreadKey[key]?.terminalIds ?? []),
    ...(panels.byThreadKey[key]?.surfaces ?? []).flatMap((surface) =>
      surface.kind === "terminal" ? surface.terminalIds : [],
    ),
  ]);
  drawer.clearTerminalUiState(ref);
  drawer.setTerminalHeight(ref, fixture.terminalHeight);
  useRightPanelStore.setState((state) => {
    const byThreadKey = { ...state.byThreadKey };
    delete byThreadKey[key];
    return { byThreadKey };
  });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  for (const terminalId of ids) {
    await command(terminalEnvironment.close, environmentId, {
      threadId,
      terminalId,
      deleteHistory: true,
    });
  }
  return {
    environmentId,
    threadId,
    clearedTerminalIds: [...ids],
    terminalHeight: fixture.terminalHeight,
  };
}

export function freezeWallClock() {
  if (window.__terminalFixtureDate) return;
  const OriginalDate = Date;
  window.__terminalFixtureDate = OriginalDate;
  const epoch = OriginalDate.parse(fixture.wallClock);
  window.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [epoch]));
    }
    static now() {
      return epoch;
    }
  };
}

export { fixture };

export async function observeSurfaces() {
  const { GhosttyTerminalSurface } = await import("../../../src/terminal/ghostty/surface");
  if (window.__terminalFixtureTrace) return window.__terminalFixtureTrace;
  const trace = [];
  const surfaces = [];
  window.__terminalFixtureTrace = trace;
  window.__terminalFixtureSurfaces = surfaces;
  const record = (event, detail = {}) => trace.push({ ms: performance.now(), event, ...detail });
  const create = GhosttyTerminalSurface.create;
  GhosttyTerminalSurface.create = async function (mount, options) {
    const id = surfaces.length;
    surfaces.push(null);
    record("create:start", { id });
    const surface = await create.call(this, mount, options);
    surfaces[id] = surface;
    record("create:ready", { id });
    return surface;
  };
  for (const method of ["write", "resetAndWrite", "clearSelection", "dispose"]) {
    const original = GhosttyTerminalSurface.prototype[method];
    GhosttyTerminalSurface.prototype[method] = function (...args) {
      record(method, { id: surfaces.indexOf(this), text: args[0] });
      return original.apply(this, args);
    };
  }
  return trace;
}

export async function write(environmentId, terminalId, data, threadId = fixture.threadId) {
  return command(terminalEnvironment.write, environmentId, { threadId, terminalId, data });
}

export function drawerState(environmentId, threadId = fixture.threadId) {
  return useTerminalUiStateStore.getState().terminalUiStateByThreadKey[
    `${environmentId}:${threadId}`
  ];
}
