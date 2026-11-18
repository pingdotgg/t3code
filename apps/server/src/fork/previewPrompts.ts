import { constVoid } from "effect/Function";
import type { Browser, BrowserContext } from "playwright-core";

// Full Chrome draws passkey sheets and print preview as browser UI that the preview stream
// cannot show, and the page takes no input until someone answers. These answer as a person
// pressing Cancel would, through CDP only, so pages run no injected script.

// Keys that hold no passkeys and fail user verification: a request a USB or phone key could
// answer rejects NotAllowedError at once, and nothing is ever registered.
const REFUSING_KEYS = (["usb", "cable"] as const).map((transport) => ({
  protocol: "ctap2",
  transport,
  hasUserVerification: true,
  isUserVerified: false,
  automaticPresenceSimulation: true,
}));

const CANCEL_PRINT_PREVIEW = `location.origin === "chrome://print" && typeof chrome.send === "function"
  && (chrome.send("closePrintPreviewDialog"), chrome.send("dialogClose"), true)`;

interface CdpSession {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, listener: (params: never) => void): unknown;
  prependListener(event: string, listener: (params: never) => void): unknown;
  createChildSession(...args: ReadonlyArray<unknown>): CdpSession;
}

// The same private seam as stubWorkerBadges in ServerBrowserContexts.ts; previewPrompts.test.ts
// fails if a Playwright change breaks it.
const rootSession = (client: Browser | BrowserContext) => {
  const { _connection: connection } = client as unknown as {
    readonly _connection?: {
      readonly toImpl?: (
        client: unknown,
      ) =>
        | { readonly _session?: CdpSession; readonly _browser?: { readonly _session?: CdpSession } }
        | undefined;
    };
  };
  const impl = connection?.toImpl?.(client);
  return impl?._browser?._session ?? impl?._session;
};

// Sent together, so Chrome handles them before any later command on the page's session.
const armKeys = (page: CdpSession) =>
  Promise.allSettled([
    page.send("WebAuthn.disable"),
    page.send("WebAuthn.enable", { enableUI: false }),
    ...REFUSING_KEYS.map((options) => page.send("WebAuthn.addVirtualAuthenticator", { options })),
  ]);

interface Attached {
  readonly sessionId: string;
  readonly targetInfo: { readonly type: string; readonly targetId: string };
}

/**
 * Arms each page as Playwright attaches it, ahead of its resume. Chrome drops a page's keys
 * whenever any session on that page detaches, as a viewer's does, so a detach arms it again.
 */
const refusePasskeys = (root: CdpSession) => {
  const attaching = new Map<string, string>();
  const pages = new Map<string, CdpSession>();
  root.prependListener("Target.attachedToTarget", ({ sessionId, targetInfo }: Attached) => {
    if (targetInfo.type === "page") attaching.set(sessionId, targetInfo.targetId);
  });
  root.on("Target.detachedFromTarget", ({ targetId }: { targetId?: string }) => {
    if (targetId) pages.delete(targetId);
  });
  const createChildSession = root.createChildSession.bind(root);
  root.createChildSession = (...args) => {
    const session = createChildSession(...args);
    // T3's own CDP sessions on a page attach through browser sessions made here.
    session.on("Target.detachedFromTarget", ({ targetId }: { targetId?: string }) => {
      const page = targetId && pages.get(targetId);
      if (page) void armKeys(page);
    });
    const targetId = attaching.get(String(args[0]));
    if (targetId) {
      attaching.delete(String(args[0]));
      pages.set(targetId, session);
      void armKeys(session);
    }
    return session;
  };
};

const cancelPrintPreviews = async (client: Browser | BrowserContext) => {
  const browser = "contexts" in client ? client : client.browser();
  if (!browser) return;
  const session = await browser.newBrowserCDPSession();
  const cancelling = new Set<string>();
  const cancel = ({ targetInfo }: { readonly targetInfo: { targetId: string; url: string } }) => {
    const { targetId, url } = targetInfo;
    if (!url.startsWith("chrome://print/") || cancelling.has(targetId)) return;
    cancelling.add(targetId);
    // A flat session would belong to Playwright's connection, which this session cannot address.
    void session
      .send("Target.attachToTarget", { targetId, flatten: false })
      .then(({ sessionId }) =>
        session.send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression: CANCEL_PRINT_PREVIEW },
          }),
        }),
      )
      .catch(() => cancelling.delete(targetId));
  };
  session.on("Target.targetCreated", cancel);
  session.on("Target.targetInfoChanged", cancel);
  session.on("Target.targetDestroyed", ({ targetId }) => cancelling.delete(targetId));
  await session.send("Target.setDiscoverTargets", { discover: true });
};

/**
 * In every page the launched browser opens from now on, passkey requests are refused and print
 * previews cancel themselves. Call once per launch, next to stubWorkerBadges.
 */
export const answerPrompts = (client: Browser | BrowserContext) => {
  const root = rootSession(client);
  if (root) refusePasskeys(root);
  void cancelPrintPreviews(client).catch(constVoid);
};
