// Electron allows one debugger per webContents; share the manager's attachment.

export interface CdpRelayTarget {
  readonly send: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    /** The extra session that sent it, such as a viewer's; the main connection has none. */
    owner?: string,
  ) => Promise<unknown>;
  readonly sessionDetached?: (owner: string) => void;
  /** The page's own CDP target id; Playwright keys the main frame by it. */
  readonly targetId: () => Promise<string>;
  readonly url: () => string;
  readonly title: () => string;
  readonly userAgent: () => string;
  /** The desktop and its server share a disk; download paths need no translation. */
  readonly setDownloadDirectory: (directory: string | null) => void;
  /** Only a popup closes this way; the tab's own page closes with its preview tab. */
  readonly close?: () => void;
}

type CdpRelayEvent = (method: string, params: unknown, sessionId: string | undefined) => void;

export interface CdpRelayPopup {
  readonly event: CdpRelayEvent;
  /** Its window closed, or its debugger went away. */
  readonly remove: () => void;
}

export interface CdpRelayConnection {
  readonly receive: (raw: string) => void;
  readonly event: CdpRelayEvent;
  /** A window the page opened; Playwright sees it as the page's popup. */
  readonly addPopup: (target: CdpRelayTarget) => CdpRelayPopup;
}

interface CdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

const isCommand = (value: unknown): value is CdpCommand =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "number" &&
  typeof (value as { method?: unknown }).method === "string";

// CDP values are plain JSON data, so their serialized size can be bounded before
// JSON.stringify allocates it. A string counts at its length unless it holds a
// character JSON may escape, which can take six code units.
const MAX_CDP_PAYLOAD_SIZE = 64 * 1024 * 1024;
const MAY_ESCAPE = /[^\x20\x21\x23-\x5b\x5d-\ud7ff\ue000-\uffff]/;
const serializedSize = (text: string) =>
  (MAY_ESCAPE.test(text) ? text.length * 6 : text.length) + 3;

const fitsPayloadBudget = (message: unknown) => {
  let remaining = MAX_CDP_PAYLOAD_SIZE;
  const visit = (value: unknown): boolean => {
    remaining -= typeof value === "string" ? serializedSize(value) : 26;
    if (remaining < 0) return false;
    if (typeof value !== "object" || value === null) return true;
    if (Array.isArray(value)) return value.every(visit);
    return Object.entries(value).every(([key, item]) => {
      remaining -= serializedSize(key);
      return visit(item);
    });
  };
  return visit(message);
};

const BROWSER_CONTEXT_ID = "t3-preview";
const ANNOUNCE = Symbol("announce");
const PAGE_SESSION_ID = "t3-preview-page";

const ACKNOWLEDGED = new Set([
  "Target.setDiscoverTargets",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.cancelDownload",
]);

interface RelayedTarget {
  readonly target: CdpRelayTarget;
  /** The session it is announced on. */
  readonly sessionId: string;
  /** Known once announced; a closed target cannot be asked for it. */
  targetId: string | null;
  removed: boolean;
  closedDialog?: unknown;
}

type RelaySession =
  | { readonly kind: "browser" }
  /** Relay-created page sessions share one real debugger; `parent` is the session that attached it. */
  | { readonly kind: "page"; readonly owner: RelayedTarget; readonly parent: string | undefined };

export function createCdpRelayConnection(
  target: CdpRelayTarget,
  write: (message: string) => void,
  close: () => void,
): CdpRelayConnection {
  let closed = false;
  const send = (message: Record<string, unknown>) => {
    if (closed) return;
    if (fitsPayloadBudget(message)) {
      write(JSON.stringify(message));
      return;
    }
    // An error reply fails only that command. A dropped event would leave
    // Playwright out of step with the page, so the relay closes instead.
    if (typeof message["id"] === "number") {
      write(
        JSON.stringify({
          id: message["id"],
          error: { code: -32000, message: "CDP payload too large" },
          ...(message["sessionId"] === undefined ? {} : { sessionId: message["sessionId"] }),
        }),
      );
      return;
    }
    closed = true;
    close();
  };
  let autoAttached = false;
  let downloadEventsEnabled = false;
  let downloads: {
    readonly behavior: "deny" | "default";
    readonly directory: string | null;
  } | null = null;
  const page: RelayedTarget = {
    target,
    sessionId: PAGE_SESSION_ID,
    targetId: null,
    removed: false,
  };
  /** The page first, then its popups in the order they opened. */
  const targets = new Set([page]);
  const sessions = new Map<string, RelaySession>([
    [PAGE_SESSION_ID, { kind: "page", owner: page, parent: undefined }],
  ]);
  const children = new Map<
    string,
    { readonly owner: RelayedTarget; readonly parent: string | undefined }
  >();
  const removeChild = (sessionId: string) => {
    children.delete(sessionId);
    for (const [id, child] of children) if (child.parent === sessionId) removeChild(id);
  };
  let sessionSequence = 0;
  const newSession = (session: RelaySession) => {
    const sessionId = `t3-preview-${session.kind}-${++sessionSequence}`;
    sessions.set(sessionId, session);
    return sessionId;
  };
  const announced = (relayed: RelayedTarget) => relayed.targetId !== null && !relayed.removed;
  const hasPageSession = (relayed: RelayedTarget) => {
    for (const session of sessions.values())
      if (session.kind === "page" && session.owner === relayed) return true;
    return false;
  };
  const targetInfo = async (relayed: RelayedTarget) => ({
    targetId: await relayed.target.targetId(),
    type: "page",
    title: relayed.target.title(),
    url: relayed.target.url(),
    attached: hasPageSession(relayed),
    ...(relayed === page
      ? { canAccessOpener: false }
      : { canAccessOpener: true, openerId: await target.targetId() }),
    browserContextId: BROWSER_CONTEXT_ID,
  });
  const attachedEvent = (relayed: RelayedTarget, info: { readonly targetId: string }) => {
    relayed.targetId = info.targetId;
    sessions.set(relayed.sessionId, { kind: "page", owner: relayed, parent: undefined });
    return {
      method: "Target.attachedToTarget",
      params: {
        sessionId: relayed.sessionId,
        targetInfo: { ...info, attached: true },
        waitingForDebugger: false,
      },
    };
  };
  /** Popups follow the page, one at a time, so Playwright already knows their opener. */
  let announcing = Promise.resolve();
  const announcePopup = (relayed: RelayedTarget) => {
    announcing = announcing.then(() =>
      targetInfo(relayed).then(
        (info) => {
          if (!relayed.removed && relayed.targetId === null) send(attachedEvent(relayed, info));
        },
        () => {},
      ),
    );
  };
  const findTarget = async (targetId: unknown) => {
    for (const relayed of targets) {
      if (relayed === page || announced(relayed)) {
        if ((await relayed.target.targetId()) === targetId) return relayed;
      }
    }
    return undefined;
  };

  const browserCommand = async (command: CdpCommand): Promise<unknown> => {
    if (ACKNOWLEDGED.has(command.method)) return {};
    switch (command.method) {
      case "Browser.setDownloadBehavior": {
        const directory = command.params?.["downloadPath"];
        const allowed = command.params?.["behavior"] !== "deny" && typeof directory === "string";
        const behavior = command.params?.["behavior"] === "deny" ? "deny" : "default";
        // Browser-scoped behavior targets Electron's app session; preview paths belong to will-download.
        const [result] = await Promise.all(
          [...targets].map((relayed) =>
            relayed.target
              .send("Page.setDownloadBehavior", { behavior }, undefined)
              .catch((cause: unknown) => {
                if (relayed === page || !relayed.removed) throw cause;
              }),
          ),
        );
        downloads = { behavior, directory: allowed ? directory : null };
        for (const relayed of targets) relayed.target.setDownloadDirectory(downloads.directory);
        downloadEventsEnabled = command.params?.["eventsEnabled"] === true;
        return result;
      }
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Electron",
          revision: "",
          userAgent: target.userAgent(),
          jsVersion: "",
        };
      case "Target.getTargetInfo":
        return {
          targetInfo: {
            targetId: "browser",
            type: "browser",
            title: "",
            url: "",
            attached: true,
            canAccessOpener: false,
          },
        };
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Target.getTargets":
        return {
          targetInfos: await Promise.all(
            [...targets]
              .filter((relayed) => relayed === page || announced(relayed))
              .map(targetInfo),
          ),
        };
      case "Target.attachToBrowserTarget":
        return { sessionId: newSession({ kind: "browser" }) };
      case "Target.attachToTarget": {
        const owner = await findTarget(command.params?.["targetId"]);
        if (!owner) throw new Error("Only this preview tab's page and its popups can be attached.");
        return { sessionId: newSession({ kind: "page", owner, parent: command.sessionId }) };
      }
      case "Target.detachFromTarget": {
        const sessionId = command.params?.["sessionId"];
        const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
        const child = typeof sessionId === "string" ? children.get(sessionId) : undefined;
        if (child !== undefined) {
          await child.owner.target.send(
            command.method,
            command.params ?? {},
            child.parent,
            undefined,
          );
          removeChild(sessionId as string);
        } else if (session?.kind === "page" && sessionId !== PAGE_SESSION_ID) {
          const targetId = session.owner.targetId ?? (await session.owner.target.targetId());
          sessions.delete(sessionId as string);
          if (!hasPageSession(session.owner))
            for (const [id, child] of children)
              if (child.owner === session.owner) children.delete(id);
          session.owner.target.sessionDetached?.(sessionId as string);
          send({
            method: "Target.detachedFromTarget",
            params: { sessionId, targetId },
            ...(session.parent === undefined ? {} : { sessionId: session.parent }),
          });
        } else if (session?.kind === "browser") {
          sessions.delete(sessionId as string);
        }
        return {};
      }
      case "Target.closeTarget": {
        const owner = await findTarget(command.params?.["targetId"]);
        if (owner === undefined || owner === page || !owner.target.close)
          throw new Error(`Not supported for a desktop preview tab: ${command.method}`);
        owner.target.close();
        return { success: true };
      }
      case "Target.setAutoAttach": {
        if (autoAttached) return {};
        autoAttached = true;
        const info = await targetInfo(page);
        return { [ANNOUNCE]: info };
      }
      default:
        throw new Error(`Not supported for a desktop preview tab: ${command.method}`);
    }
  };

  const pageCommand = (command: CdpCommand): Promise<unknown> => {
    const session = sessions.get(command.sessionId!);
    const child = session?.kind === "page" ? undefined : command.sessionId;
    const owner = session?.kind === "page" ? session.owner : children.get(child!)?.owner;
    if (owner === undefined) return Promise.reject(new Error("Unknown or detached CDP session"));
    if (command.method === "Target.detachFromTarget") return browserCommand(command);
    const extra = child === undefined && command.sessionId !== PAGE_SESSION_ID;
    // Child frames/workers pause on auto-attach until resumed; only a main page can skip this command.
    if (command.method === "Runtime.runIfWaitingForDebugger" && child === undefined) {
      return Promise.resolve({});
    }
    // Playwright asks for this on every page; the host emulates focus only while it is in use.
    if (command.method === "Emulation.setFocusEmulationEnabled") return Promise.resolve({});
    const result = owner.target.send(
      command.method,
      command.params ?? {},
      child,
      extra ? command.sessionId : undefined,
    );
    if (command.method !== "Page.enable" || child !== undefined) return result;
    return result.then((result) => {
      // Popup adoption may have buffered the dialog before this session existed.
      if (
        !owner.removed &&
        sessions.get(command.sessionId!) === session &&
        owner.closedDialog !== undefined
      ) {
        send({
          method: "Page.javascriptDialogClosed",
          params: owner.closedDialog,
          sessionId: command.sessionId,
        });
      }
      return result;
    });
  };

  const eventFor =
    (relayed: RelayedTarget): CdpRelayEvent =>
    (method, params, sessionId) => {
      if (relayed.removed) return;
      if (sessionId && children.get(sessionId)?.owner !== relayed) return;
      if (method === "Page.javascriptDialogOpening") relayed.closedDialog = undefined;
      else if (method === "Page.javascriptDialogClosed") relayed.closedDialog = params;
      if (announced(relayed) && !hasPageSession(relayed)) return;
      const child = (params as { sessionId?: unknown } | null | undefined)?.sessionId;
      if (method === "Target.attachedToTarget" && typeof child === "string") {
        children.set(child, { owner: relayed, parent: sessionId || undefined });
      } else if (method === "Target.detachedFromTarget" && typeof child === "string") {
        removeChild(child);
      }
      if (!announced(relayed)) return;
      if (method.startsWith("Page.download")) method = method.replace("Page.", "Browser.");
      // Download events are the browser's; Playwright listens on its root session.
      if (method.startsWith("Browser.download")) {
        if (downloadEventsEnabled) send({ method, params });
        return;
      }
      // Electron reports the page's own events with an empty session id.
      if (sessionId) {
        send({ method, params, sessionId });
        return;
      }
      for (const [id, session] of sessions)
        if (session.kind === "page" && session.owner === relayed)
          send({ method, params, sessionId: id });
    };

  const removePopup = (relayed: RelayedTarget) => {
    if (relayed.removed) return;
    relayed.removed = true;
    targets.delete(relayed);
    for (const [id, child] of children) if (child.owner === relayed) children.delete(id);
    const targetId = relayed.targetId;
    if (targetId === null) return;
    for (const [id, session] of sessions) {
      if (session.kind !== "page" || session.owner !== relayed) continue;
      sessions.delete(id);
      send({
        method: "Target.detachedFromTarget",
        params: { sessionId: id, targetId },
        ...(session.parent === undefined ? {} : { sessionId: session.parent }),
      });
    }
  };

  return {
    receive: (raw) => {
      if (closed) return;
      let command: unknown;
      try {
        command = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isCommand(command)) return;
      const result =
        command.sessionId === undefined || sessions.get(command.sessionId)?.kind === "browser"
          ? browserCommand(command)
          : pageCommand(command);
      const route = command.sessionId === undefined ? {} : { sessionId: command.sessionId };
      // Reply as commands finish so slow commands cannot block later replies.
      void result.then(
        (value) => {
          const info =
            typeof value === "object" && value !== null && ANNOUNCE in value
              ? (value as { [ANNOUNCE]: { readonly targetId: string } })[ANNOUNCE]
              : undefined;
          send({ id: command.id, result: info ? {} : (value ?? {}), ...route });
          if (!info) return;
          send(attachedEvent(page, info));
          for (const relayed of targets) if (relayed !== page) announcePopup(relayed);
        },
        (cause: unknown) =>
          send({
            id: command.id,
            error: {
              code: -32000,
              message: cause instanceof Error ? cause.message : String(cause),
            },
            ...route,
          }),
      );
    },
    event: eventFor(page),
    addPopup: (popupTarget) => {
      const relayed: RelayedTarget = {
        target: popupTarget,
        sessionId: `t3-preview-popup-${++sessionSequence}`,
        targetId: null,
        removed: false,
      };
      targets.add(relayed);
      if (downloads !== null) {
        popupTarget.setDownloadDirectory(downloads.directory);
        void popupTarget
          .send("Page.setDownloadBehavior", { behavior: downloads.behavior }, undefined)
          .catch(() => {});
      }
      if (announced(page)) announcePopup(relayed);
      return { event: eventFor(relayed), remove: () => removePopup(relayed) };
    },
  };
}
