import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import {
  attachRegistrationHandler,
  bindCommands,
  configureExtensionCommandEnvironment,
  discardStagedGlobalCommands,
  dispatchExtensionCommand,
  extensionCommandForKeydown,
  extensionCommandRevision,
  installExtensionCommandKeybindings,
  listExtensionCommandConflicts,
  listPaletteExtensionCommands,
  noteClientProviderConnection,
  registerCommands,
  setActiveExtensionThreadRef,
  stageGlobalCommands,
  stagedGlobalCommandsFor,
  subscribeExtensionCommands,
  unconfigureExtensionCommandEnvironment,
  unregisterCommands,
  unregisterInstallationCommands,
  type ExtensionCommandDescriptor,
  type ExtensionCommandEnvironmentDeps,
} from "./extensionCommandRegistry";

const ENV = "env-a";
const INSTALL = "ext.a";
const SURFACE = `${INSTALL}/panel`;

const context: ViewContext = {
  client: "web",
  resource: {
    namespace: "t3.extensions",
    id: INSTALL,
    environmentId: ENV,
    projectId: "project-a",
    threadId: "thread-a",
  },
};

const envDeps = (epoch = 1): ExtensionCommandEnvironmentDeps => ({
  installationGeneration: (id: string) => (id === INSTALL ? epoch : null),
  installationSurfaces: (id: string) =>
    id === INSTALL
      ? [
          {
            id: SURFACE,
            title: "Panel",
            placements: ["side-panel"],
            clients: ["web"],
            scope: "thread",
            stateVersion: 1,
          },
        ]
      : null,
  installationGrants: (id: string) => (id === INSTALL ? ["project-a"] : null),
  client: "web",
});

function register(
  commands: readonly ExtensionCommandDescriptor[],
  extras?: {
    capabilities?: readonly string[];
    installationScoped?: boolean;
    handler?: (call: { commandId: string; context: ViewContext }) => void;
  },
) {
  return registerCommands({
    environmentId: ENV,
    installationId: INSTALL,
    installationGeneration: 1,
    context,
    commands,
    capabilities: extras?.capabilities ?? ["t3.ui/keybindings"],
    ...(extras?.installationScoped !== undefined
      ? { installationScoped: extras.installationScoped }
      : {}),
    ...(extras?.handler !== undefined ? { handler: extras.handler } : {}),
  });
}

const command = (partial: Partial<ExtensionCommandDescriptor>): ExtensionCommandDescriptor => ({
  id: "run",
  title: "Run",
  scope: "surface",
  ...partial,
});

function keydownEvent(
  key: string,
  mods?: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean },
) {
  return {
    key,
    ctrlKey: mods?.ctrl ?? false,
    metaKey: mods?.meta ?? false,
    shiftKey: mods?.shift ?? false,
    altKey: mods?.alt ?? false,
  };
}

/** Minimal DOM stand-in for the focus markers `ExtensionSurface` paints. */
function installFakeDom(viewKey: string | null, surfaceId: string | null) {
  class FakeHTMLElement {
    closest(selector: string) {
      if (selector === "[data-extension-view]" && viewKey !== null)
        return { dataset: { extensionView: viewKey } };
      if (selector === "[data-extension-surface]" && surfaceId !== null)
        return { dataset: { extensionSurface: surfaceId } };
      return null;
    }
  }
  const globals = globalThis as Record<string, unknown>;
  const previous = { document: globals.document, HTMLElement: globals.HTMLElement };
  globals.HTMLElement = FakeHTMLElement;
  globals.document = {
    activeElement: new FakeHTMLElement(),
    documentElement: { dataset: {} },
  };
  return () => {
    if (previous.document === undefined) delete globals.document;
    else globals.document = previous.document;
    if (previous.HTMLElement === undefined) delete globals.HTMLElement;
    else globals.HTMLElement = previous.HTMLElement;
  };
}

let restoreDom: (() => void) | null = null;

afterEach(() => {
  restoreDom?.();
  restoreDom = null;
  setActiveExtensionThreadRef(null);
  unconfigureExtensionCommandEnvironment(ENV);
});

describe("registerCommands", () => {
  it("rejects malformed commands and keeps the valid ones", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const { results } = register([
      command({ id: "9bad" }),
      command({ id: "ok", scope: "thread" }),
      command({ id: "badscope", scope: "nope" as never }),
      command({ id: "badwhen", when: "&&" }),
      command({ id: "badkey", defaultKey: "ctrl+alt" }),
    ]);
    expect(results.map((r) => [r.commandId, r.status])).toEqual([
      ["9bad", "rejected"],
      ["ok", "registered"],
      ["badscope", "rejected"],
      ["badwhen", "rejected"],
      ["badkey", "rejected"],
    ]);
  });

  it("enforces the scope grants", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const withoutGlobal = register([command({ scope: "global" })]);
    expect(withoutGlobal.results[0]?.status).toBe("rejected");
    expect(withoutGlobal.results[0]?.reason).toContain("keybindings.global");

    const withGlobal = register([command({ id: "run2", scope: "global" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
    });
    expect(withGlobal.results[0]?.status).toBe("registered");
  });

  it("gates activation on global scope, panels grant, and own surfaces", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const activation = { surfaceId: SURFACE, placement: "side-panel" as const };
    const nonGlobal = register([command({ scope: "thread", activation })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global", "t3.ui/panels"],
      installationScoped: true,
    });
    expect(nonGlobal.results[0]?.status).toBe("rejected");

    const noPanelsGrant = register([command({ scope: "global", activation })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
      installationScoped: true,
    });
    expect(noPanelsGrant.results[0]?.reason).toContain("t3.ui/panels");

    const foreignSurface = register(
      [command({ scope: "global", activation: { ...activation, surfaceId: "ext.b/panel" } })],
      {
        capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global", "t3.ui/panels"],
        installationScoped: true,
      },
    );
    expect(foreignSurface.results[0]?.status).toBe("rejected");

    const legal = register([command({ id: "open", scope: "global", activation })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global", "t3.ui/panels"],
      installationScoped: true,
    });
    expect(legal.results[0]?.status).toBe("registered");
  });

  it("replays the same registration set idempotently", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const first = register([command({ scope: "thread" })]);
    const second = register([command({ scope: "thread" })]);
    expect(second.commandSetToken).toBe(first.commandSetToken);
  });
});

describe("bindCommands", () => {
  const bindingCall = (token: string, extra?: Record<string, unknown>) => ({
    environmentId: ENV,
    extensionId: INSTALL,
    hostKey: "host-1",
    viewId: "view-1",
    context,
    commandSetToken: token,
    handler: vi.fn(),
    ...extra,
  });

  it("mints bindings for a live registration and is idempotent per view", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const { commandSetToken } = register([command({ scope: "surface" })]);
    const first = bindCommands(bindingCall(commandSetToken));
    const again = bindCommands(bindingCall(commandSetToken));
    expect(again.bindingId).toBe(first.bindingId);
    const other = bindCommands(bindingCall(commandSetToken, { viewId: "view-2" }));
    expect(other.bindingId).not.toBe(first.bindingId);
  });

  it("rejects unknown, foreign, and stale tokens", () => {
    let epoch = 1;
    configureExtensionCommandEnvironment(ENV, {
      ...envDeps(),
      installationGeneration: (id: string) => (id === INSTALL ? epoch : null),
    });
    const { commandSetToken } = register([command({ scope: "surface" })]);
    expect(() => bindCommands(bindingCall("cmdset-nope"))).toThrow(/Unknown command set token/);
    expect(() => bindCommands(bindingCall(commandSetToken, { extensionId: "ext.b" }))).toThrow(
      /belongs elsewhere/,
    );
    expect(() =>
      bindCommands(
        bindingCall(commandSetToken, {
          context: { ...context, resource: { ...context.resource, projectId: "project-b" } },
        }),
      ),
    ).toThrow(/Context does not match/);

    // Re-registration bumps the client epoch — a token minted under the old
    // installation instance goes stale rather than resurrecting.
    epoch = 2;
    expect(() => bindCommands(bindingCall(commandSetToken, { viewId: "view-2" }))).toThrow(
      /predates the installation/,
    );
  });
});

describe("dispatchExtensionCommand", () => {
  it("dispatches a global command to the single eligible binding", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const handler = vi.fn();
    const { commandSetToken } = register([command({ scope: "global" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
    });
    const view = bindCommands({
      environmentId: ENV,
      extensionId: INSTALL,
      hostKey: "host-1",
      viewId: "view-1",
      context,
      commandSetToken,
      handler,
    });
    expect(view.bindingId).toBeTruthy();
    setActiveExtensionThreadRef(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")));
    expect(dispatchExtensionCommand(`ext.${INSTALL}.run`).kind).toBe("dispatched");
    expect(handler).toHaveBeenCalledWith({ commandId: "run", context });
  });

  it("reports ambiguity when two eligible bindings share a command", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const { commandSetToken } = register([command({ scope: "global" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
    });
    for (const viewId of ["view-1", "view-2"]) {
      bindCommands({
        environmentId: ENV,
        extensionId: INSTALL,
        hostKey: "host-1",
        viewId,
        context,
        commandSetToken,
        handler: vi.fn(),
      });
    }
    setActiveExtensionThreadRef(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")));
    expect(dispatchExtensionCommand(`ext.${INSTALL}.run`).kind).toBe("ambiguous");
  });

  it("falls back to the installation handler, then reports unavailable", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const handler = vi.fn();
    register([command({ scope: "global" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
      installationScoped: true,
      handler,
    });
    expect(dispatchExtensionCommand(`ext.${INSTALL}.run`).kind).toBe("dispatched");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(dispatchExtensionCommand(`ext.${INSTALL}.missing`).kind).toBe("unavailable");
  });

  it("fires a staged installation handler attached after the wire flush", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const handler = vi.fn();
    // The staged path commits `{commands}` over the seam — the handler is a
    // local function and lands via attachRegistrationHandler.
    const { commandSetToken } = register([command({ scope: "global" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
      installationScoped: true,
    });
    expect(dispatchExtensionCommand(`ext.${INSTALL}.run`).kind).toBe("unavailable");
    attachRegistrationHandler(ENV, commandSetToken, handler);
    expect(dispatchExtensionCommand(`ext.${INSTALL}.run`).kind).toBe("dispatched");
    expect(handler).toHaveBeenCalledTimes(1);
    // A foreign environment's token cannot be attached to.
    attachRegistrationHandler("env-b", commandSetToken, handler);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("honors the focused view before any other tier", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    restoreDom = installFakeDom("host-1:view-1", SURFACE);
    const focused = vi.fn();
    const unfocused = vi.fn();
    const { commandSetToken } = register([command({ scope: "global" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
    });
    bindCommands({
      environmentId: ENV,
      extensionId: INSTALL,
      hostKey: "host-1",
      viewId: "view-1",
      context,
      commandSetToken,
      handler: focused,
    });
    bindCommands({
      environmentId: ENV,
      extensionId: INSTALL,
      hostKey: "host-9",
      viewId: "view-9",
      context,
      commandSetToken,
      handler: unfocused,
    });
    expect(dispatchExtensionCommand(`ext.${INSTALL}.run`).kind).toBe("dispatched");
    expect(focused).toHaveBeenCalledTimes(1);
    expect(unfocused).not.toHaveBeenCalled();
  });

  it("keeps a surface-scoped command unfired when its view lacks focus", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const handler = vi.fn();
    const { commandSetToken } = register([command({ scope: "surface" })]);
    bindCommands({
      environmentId: ENV,
      extensionId: INSTALL,
      hostKey: "host-1",
      viewId: "view-1",
      context,
      commandSetToken,
      handler,
    });
    // No focused extension view — a surface command must not fire globally.
    expect(dispatchExtensionCommand(`ext.${INSTALL}.run`).kind).toBe("unavailable");
    expect(handler).not.toHaveBeenCalled();
  });

  it("matches a thread-scoped binding only on the active thread", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    restoreDom = installFakeDom("host-1:view-1", SURFACE);
    const handler = vi.fn();
    const { commandSetToken } = register([command({ scope: "thread" })]);
    bindCommands({
      environmentId: ENV,
      extensionId: INSTALL,
      hostKey: "host-1",
      viewId: "view-1",
      context,
      commandSetToken,
      handler,
    });
    setActiveExtensionThreadRef(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-b")));
    expect(dispatchExtensionCommand(`ext.${INSTALL}.run`).kind).toBe("unavailable");
    setActiveExtensionThreadRef(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")));
    expect(dispatchExtensionCommand(`ext.${INSTALL}.run`).kind).toBe("dispatched");
  });
});

describe("keydown matching + palette enumeration", () => {
  it("resolves plugin default keys to the ext command name", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    register([command({ scope: "global", defaultKey: "ctrl+alt+r" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
    });
    expect(extensionCommandForKeydown(keydownEvent("r", { ctrl: true, alt: true }), "Linux")).toBe(
      `ext.${INSTALL}.run`,
    );
    expect(extensionCommandForKeydown(keydownEvent("r", { ctrl: true }), "Linux")).toBeNull();
    expect(
      extensionCommandForKeydown(keydownEvent("x", { ctrl: true, alt: true }), "Linux"),
    ).toBeNull();
  });

  it("lists palette items with per-scope enabled state", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    restoreDom = installFakeDom("host-1:view-1", SURFACE);
    register(
      [
        command({ id: "surfaceCmd", scope: "surface" }),
        command({ id: "globalCmd", scope: "global" }),
      ],
      { capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"] },
    );
    const items = listPaletteExtensionCommands();
    const surface = items.find((item) => item.command === `ext.${INSTALL}.surfaceCmd`);
    const global = items.find((item) => item.command === `ext.${INSTALL}.globalCmd`);
    // A surface command is enabled only when a focused view binds it.
    expect(surface?.enabled).toBe(false);
    // A global command with no binding and no handler/activation is disabled.
    expect(global?.enabled).toBe(false);
  });

  it("reports plugin-vs-plugin key conflicts", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    register(
      [
        command({ id: "one", defaultKey: "ctrl+alt+r" }),
        command({ id: "two", defaultKey: "ctrl+alt+r" }),
      ],
      { capabilities: ["t3.ui/keybindings"] },
    );
    const conflicts = listExtensionCommandConflicts(ENV);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.winner).toBe("plugin");
    expect(conflicts[0]?.key).toBe("ctrl+alt+r");
  });
});

describe("lifecycle cleanup", () => {
  it("unregisters a command set and drops its bindings", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const handler = vi.fn();
    const { commandSetToken } = register([command({ scope: "global" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
    });
    bindCommands({
      environmentId: ENV,
      extensionId: INSTALL,
      hostKey: "host-1",
      viewId: "view-1",
      context,
      commandSetToken,
      handler,
    });
    expect(unregisterCommands(ENV, commandSetToken, INSTALL)).toBe(true);
    expect(dispatchExtensionCommand(`ext.${INSTALL}.run`).kind).toBe("unavailable");
    expect(unregisterCommands(ENV, commandSetToken, INSTALL)).toBe(false);
  });

  it("refuses to unregister another installation's command set", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const { commandSetToken } = register([command({ scope: "global" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
    });
    expect(unregisterCommands(ENV, commandSetToken, "other.installation")).toBe(false);
    // The owner's set is still live and dispatchable.
    expect(unregisterCommands(ENV, commandSetToken, INSTALL)).toBe(true);
  });

  it("drops everything an installation owned", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    register([command({ scope: "global" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
      installationScoped: true,
      handler: vi.fn(),
    });
    stageGlobalCommands(ENV, INSTALL, [], undefined);
    unregisterInstallationCommands(ENV, INSTALL);
    expect(dispatchExtensionCommand(`ext.${INSTALL}.run`).kind).toBe("unavailable");
    expect(stagedGlobalCommandsFor(ENV, INSTALL)).toHaveLength(0);
  });
});

describe("staged global commands", () => {
  it("stages and discards uncommitted entries", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const listener = vi.fn();
    const entry = stageGlobalCommands(ENV, INSTALL, [command({ scope: "global" })], undefined);
    entry.listeners.add(listener);
    expect(entry.status).toBe("staged");
    discardStagedGlobalCommands(ENV, INSTALL);
    expect(entry.status).toBe("rejected");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(stagedGlobalCommandsFor(ENV, INSTALL)).toHaveLength(0);
  });
});

describe("connection-aware arbitration regressions", () => {
  it("arbitrates across distinct registration sets", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    setActiveExtensionThreadRef(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")));
    const first = register([command({ scope: "global", title: "First" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
    });
    const second = register([command({ scope: "global", title: "Second" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
    });
    const a = vi.fn();
    const b = vi.fn();
    for (const [registration, handler, hostKey] of [
      [first, a, "host-a"],
      [second, b, "host-b"],
    ] as const) {
      bindCommands({
        environmentId: ENV,
        extensionId: INSTALL,
        hostKey,
        viewId: "view-1",
        context,
        commandSetToken: registration.commandSetToken,
        handler,
      });
    }
    // Two sets each contributing one viewer is ambiguity, not first-wins.
    expect(dispatchExtensionCommand("ext.ext.a.run")).toEqual({ kind: "ambiguous" });
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("installation handler context retains the workspace revision", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const handler = vi.fn();
    registerCommands({
      environmentId: ENV,
      installationId: INSTALL,
      installationGeneration: 1,
      context: { ...context, workspaceRevision: "valid-revision" },
      commands: [command({ scope: "global" })],
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
      installationScoped: true,
      handler,
    });
    expect(dispatchExtensionCommand("ext.ext.a.run")).toEqual({ kind: "dispatched" });
    expect(handler.mock.calls[0]![0].context.workspaceRevision).toBe("valid-revision");
  });

  it("a stale installation generation cannot dispatch its handler", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const handler = vi.fn();
    register([command({ scope: "global" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
      installationScoped: true,
      handler,
    });
    // The environment now reports a newer installation generation.
    configureExtensionCommandEnvironment(ENV, envDeps(2));
    expect(dispatchExtensionCommand("ext.ext.a.run")).toEqual({ kind: "unavailable" });
    expect(handler).not.toHaveBeenCalled();
  });
});

it("palette enabled state agrees with focused-view arbitration", () => {
  configureExtensionCommandEnvironment(ENV, envDeps());
  setActiveExtensionThreadRef(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")));
  const registration = register([command({ scope: "global" })], {
    capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
  });
  for (const hostKey of ["host-a", "host-b"]) {
    bindCommands({
      environmentId: ENV,
      extensionId: INSTALL,
      hostKey,
      viewId: "view-1",
      context,
      commandSetToken: registration.commandSetToken,
      handler: vi.fn(),
    });
  }
  restoreDom = installFakeDom("host-a:view-1", SURFACE);
  expect(dispatchExtensionCommand("ext.ext.a.run")).toEqual({ kind: "dispatched" });
  expect(
    listPaletteExtensionCommands().find((item) => item.command === "ext.ext.a.run")?.enabled,
  ).toBe(true);
});

it("the active environment's own installation handler wins", () => {
  const handlers = [vi.fn(), vi.fn()];
  for (const [index, env] of [ENV, "env-b"].entries()) {
    configureExtensionCommandEnvironment(env, envDeps());
    registerCommands({
      environmentId: env,
      installationId: INSTALL,
      installationGeneration: 1,
      context: { ...context, resource: { ...context.resource, environmentId: env } },
      commands: [command({ scope: "global" })],
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
      installationScoped: true,
      handler: handlers[index]!,
    });
  }
  setActiveExtensionThreadRef(
    scopeThreadRef(EnvironmentId.make("env-b"), ThreadId.make("thread-a")),
  );
  try {
    expect(dispatchExtensionCommand("ext.ext.a.run")).toEqual({ kind: "dispatched" });
    expect(handlers[1]).toHaveBeenCalledOnce();
    expect(handlers[0]).not.toHaveBeenCalled();
  } finally {
    unconfigureExtensionCommandEnvironment("env-b");
  }
});

describe("connection-aware arbitration regressions (r2)", () => {
  it("no active thread must not dispatch an arbitrary thread binding", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const handler = vi.fn();
    const r = register([command({ scope: "global" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
    });
    bindCommands({
      environmentId: ENV,
      extensionId: INSTALL,
      hostKey: "h",
      viewId: "v",
      context,
      commandSetToken: r.commandSetToken,
      handler,
    });
    expect(dispatchExtensionCommand("ext.ext.a.run")).toEqual({ kind: "unavailable" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("palette checks the environment pinned by its own row", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    configureExtensionCommandEnvironment("env-b", envDeps());
    try {
      register([command({ scope: "global" })], {
        capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
        installationScoped: true,
        handler: vi.fn(),
      });
      registerCommands({
        environmentId: "env-b",
        installationId: INSTALL,
        installationGeneration: 1,
        context: { ...context, resource: { ...context.resource, environmentId: "env-b" } },
        commands: [command({ scope: "global" })],
        capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
      });
      setActiveExtensionThreadRef(
        scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")),
      );
      expect(dispatchExtensionCommand("ext.ext.a.run", "env-b")).toEqual({ kind: "unavailable" });
      expect(listPaletteExtensionCommands().find((x) => x.environmentId === "env-b")?.enabled).toBe(
        false,
      );
    } finally {
      unconfigureExtensionCommandEnvironment("env-b");
    }
  });

  it("activation with an ineligible thread stays disabled in palette", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    register(
      [command({ scope: "global", activation: { surfaceId: SURFACE, placement: "side-panel" } })],
      {
        capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global", "t3.ui/panels"],
        installationScoped: true,
      },
    );
    setActiveExtensionThreadRef(
      scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("missing-thread")),
    );
    expect(dispatchExtensionCommand("ext.ext.a.run")).toEqual({ kind: "unavailable" });
    expect(listPaletteExtensionCommands()[0]?.enabled).toBe(false);
  });

  it("replay does not keep a command that revalidation rejected", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    noteClientProviderConnection(ENV, true);
    const handler = vi.fn();
    const commands = [
      command({ scope: "global", activation: { surfaceId: SURFACE, placement: "side-panel" } }),
    ];
    register(commands, {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global", "t3.ui/panels"],
      installationScoped: true,
      handler,
    });
    noteClientProviderConnection(ENV, false);
    noteClientProviderConnection(ENV, true);
    const replay = register(commands, {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
      installationScoped: true,
    });
    expect(replay.results[0]?.status).toBe("rejected");
    expect(dispatchExtensionCommand("ext.ext.a.run")).toEqual({ kind: "unavailable" });
  });

  it("replayed view dispatch uses the refreshed workspace revision", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    noteClientProviderConnection(ENV, true);
    const commands = [command({ scope: "global" })];
    const caps = ["t3.ui/keybindings", "t3.ui/keybindings.global"];
    const oldContext = { ...context, workspaceRevision: "old" };
    const newContext = { ...context, workspaceRevision: "new" };
    const r = registerCommands({
      environmentId: ENV,
      installationId: INSTALL,
      installationGeneration: 1,
      context: oldContext,
      commands,
      capabilities: caps,
    });
    const handler = vi.fn();
    bindCommands({
      environmentId: ENV,
      extensionId: INSTALL,
      hostKey: "h",
      viewId: "v",
      context: oldContext,
      commandSetToken: r.commandSetToken,
      handler,
    });
    noteClientProviderConnection(ENV, false);
    noteClientProviderConnection(ENV, true);
    registerCommands({
      environmentId: ENV,
      installationId: INSTALL,
      installationGeneration: 1,
      context: newContext,
      commands,
      capabilities: caps,
    });
    bindCommands({
      environmentId: ENV,
      extensionId: INSTALL,
      hostKey: "h",
      viewId: "v",
      context: newContext,
      commandSetToken: r.commandSetToken,
      handler,
    });
    setActiveExtensionThreadRef(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")));
    expect(dispatchExtensionCommand("ext.ext.a.run")).toEqual({ kind: "dispatched" });
    expect(handler.mock.calls[0]![0].context.workspaceRevision).toBe("new");
  });

  it("conflicts identify the losing plugin consistently with default dispatch", () => {
    configureExtensionCommandEnvironment(ENV, { ...envDeps(), keybindings: () => [] });
    register([
      command({ id: "one", defaultKey: "ctrl+alt+r" }),
      command({ id: "two", defaultKey: "ctrl+alt+r" }),
    ]);
    expect(extensionCommandForKeydown(keydownEvent("r", { ctrl: true, alt: true }))).toBe(
      "ext.ext.a.one",
    );
    expect(listExtensionCommandConflicts(ENV)[0]?.loser).toBe("ext.ext.a.two");
  });

  it("client lifetime listener dispatches a user ext shortcut and honors native precedence", () => {
    configureExtensionCommandEnvironment(ENV, envDeps());
    const invoke = vi.fn();
    register([command({ scope: "global", defaultKey: "ctrl+alt+r" })], {
      capabilities: ["t3.ui/keybindings", "t3.ui/keybindings.global"],
      installationScoped: true,
      handler: invoke,
    });
    const oldDocument = globalThis.document;
    const oldHTMLElement = globalThis.HTMLElement;
    globalThis.HTMLElement = class {} as never;
    const listeners = new Map<string, (event: unknown) => void>();
    Object.assign(globalThis, {
      document: {
        activeElement: null,
        querySelector: () => null,
        addEventListener: (n: string, h: (event: unknown) => void) => listeners.set(n, h),
        removeEventListener: (n: string) => listeners.delete(n),
      },
    });
    let rules = [{ command: "ext.ext.a.run", shortcut: parseKeybindingShortcut("ctrl+alt+x") }];
    const close = installExtensionCommandKeybindings(() => rules as never);
    const event = (key: string) => ({
      ...keydownEvent(key, { ctrl: true, alt: true }),
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    try {
      listeners.get("keydown")!(event("x"));
      expect(invoke).toHaveBeenCalledOnce();
      rules = [{ command: "thread.new", shortcut: parseKeybindingShortcut("ctrl+alt+r") }];
      listeners.get("keydown")!(event("r"));
      expect(invoke).toHaveBeenCalledOnce();
      rules = [];
      listeners.get("keydown")!(event("r"));
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      close();
      globalThis.HTMLElement = oldHTMLElement;
      if (oldDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else globalThis.document = oldDocument;
    }
  });
});

describe("palette focus and conditional conflicts (r3)", () => {
  it("focus changes invalidate palette and unsubscribe removes observers", async () => {
    const old = globalThis.document;
    const target = new EventTarget();
    Object.assign(globalThis, { document: target });
    const listener = vi.fn();
    const close = subscribeExtensionCommands(listener);
    try {
      const before = extensionCommandRevision();
      target.dispatchEvent(new Event("focusin"));
      await Promise.resolve();
      expect(extensionCommandRevision()).toBeGreaterThan(before);
      expect(listener).toHaveBeenCalledOnce();
      close();
      target.dispatchEvent(new Event("focusout"));
      await Promise.resolve();
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      close();
      if (old === undefined) delete (globalThis as { document?: unknown }).document;
      else globalThis.document = old;
    }
  });

  it("conflict report must not declare an inactive when clause the winner", () => {
    configureExtensionCommandEnvironment(ENV, { ...envDeps(), keybindings: () => [] });
    register([
      command({ id: "one", defaultKey: "ctrl+alt+r", when: "terminalFocus" }),
      command({ id: "two", defaultKey: "ctrl+alt+r" }),
    ]);
    expect(extensionCommandForKeydown(keydownEvent("r", { ctrl: true, alt: true }), "Linux")).toBe(
      "ext.ext.a.two",
    );
    expect(listExtensionCommandConflicts(ENV)).toEqual([]);
  });
});
