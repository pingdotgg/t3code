// @effect-diagnostics nodeBuiltinImport:off - Adapts native debugger callbacks to a local Playwright connection.
import {
  PreviewAutomationClickInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationTypeInput,
  PreviewAutomationHoverInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSelectInput,
  PreviewAutomationDragInput,
  PreviewAutomationWaitForInput,
  PreviewAutomationUploadInput,
  PreviewAutomationDialogInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationResizeInput,
  PreviewAutomationSetColorSchemeInput,
  type PreviewViewportSetting,
  type DesktopTabBinding,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
} from "@t3tools/contracts";
import * as PageOperations from "@t3tools/shared/previewPage";
import { BrowserControlInterrupted, SessionControl } from "@t3tools/shared/previewSessionControl";
import { redactSensitiveValues } from "@t3tools/shared/credentialFill";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import type * as NodeWS from "@effect/platform-node/NodeWS";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import { chromium, type Browser, type Page, type Dialog, type FileChooser } from "playwright-core";
import { createCdpRelayConnection, type CdpRelayTarget } from "./CdpRelay.ts";

const decodeNavigate = Schema.decodeUnknownSync(PreviewAutomationNavigateInput);
const decodeClick = Schema.decodeUnknownSync(PreviewAutomationClickInput);
const decodeType = Schema.decodeUnknownSync(PreviewAutomationTypeInput);
const decodeHover = Schema.decodeUnknownSync(PreviewAutomationHoverInput);
const decodePress = Schema.decodeUnknownSync(PreviewAutomationPressInput);
const decodeScroll = Schema.decodeUnknownSync(PreviewAutomationScrollInput);
const decodeSelect = Schema.decodeUnknownSync(PreviewAutomationSelectInput);
const decodeDrag = Schema.decodeUnknownSync(PreviewAutomationDragInput);
const decodeWaitFor = Schema.decodeUnknownSync(PreviewAutomationWaitForInput);
const decodeUpload = Schema.decodeUnknownSync(PreviewAutomationUploadInput);
const decodeDialog = Schema.decodeUnknownSync(PreviewAutomationDialogInput);
const decodeEvaluate = Schema.decodeUnknownSync(PreviewAutomationEvaluateInput);
const decodeResize = Schema.decodeUnknownSync(PreviewAutomationResizeInput);
const decodeSetColorScheme = Schema.decodeUnknownSync(PreviewAutomationSetColorSchemeInput);

/** Owns tab-scoped local CDP endpoints. Closing it disconnects Playwright, never the user's page. */
export class DesktopTabRunner {
  private readonly scope = Scope.makeUnsafe();
  private browser: Browser | null = null;
  private page: Page | null = null;
  private acting = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private dialog: Dialog | null = null;
  private resolvingDialogs = 0;
  private fileChooser: FileChooser | null = null;
  private lastViewport: { width: number; height: number } | null = null;
  private setting: PreviewViewportSetting;
  private colorScheme: "light" | "dark" | "system";
  private target: CdpRelayTarget | null = null;
  private readonly listeners = new Set<
    (method: string, params: unknown, sessionId: string) => void
  >();
  private readonly closeClients = new Set<() => void>();
  private readonly publicEndpoints = new Set<Scope.Closeable>();
  private readonly contexts = new Map<number, unknown>();
  private contextVersion = 0;
  private readonly secrets = new Set<string>();
  readonly control = new SessionControl(null, () => {
    if (this.page) PageOperations.invalidateRefs(this.page);
  });

  readonly binding: DesktopTabBinding;
  readonly connectionId: string;
  private readonly redact: <A>(value: A) => A;
  private readonly changed: (active: boolean) => void;
  private readonly pointer: PageOperations.PointerReporter;
  constructor(
    binding: DesktopTabBinding,
    connectionId: string,
    changed: (active: boolean) => void,
    redact: <A>(value: A) => A = (value) => value,
    pointer: PageOperations.PointerReporter = async () => {},
  ) {
    this.binding = binding;
    this.setting = binding.snapshot.viewport ?? { _tag: "fill" };
    this.colorScheme = binding.snapshot.colorScheme ?? "system";
    this.connectionId = connectionId;
    this.changed = changed;
    this.redact = redact;
    this.pointer = pointer;
  }

  async attach(
    target: CdpRelayTarget,
    events: {
      on: (listener: (method: string, params: unknown, sessionId: string) => void) => () => void;
      interceptDialogs?: (agentOwnsPage: () => boolean) => () => void;
    },
  ) {
    this.target = target;
    const restoreDialogs = events.interceptDialogs?.(() => this.ownsDialogs());
    if (restoreDialogs)
      await Effect.runPromise(
        Effect.addFinalizer(() => Effect.sync(restoreDialogs)).pipe(Scope.provide(this.scope)),
      );
    const unsubscribe = events.on((method, params, sessionId) => {
      if (method === "Page.javascriptDialogClosed") this.dialog = null;
      if (!sessionId) {
        if (method === "Runtime.executionContextCreated") {
          const context = (params as { context: { id: number } }).context;
          this.contexts.set(context.id, params);
          this.contextVersion++;
        } else if (method === "Runtime.executionContextDestroyed") {
          this.contexts.delete((params as { executionContextId: number }).executionContextId);
        } else if (method === "Runtime.executionContextsCleared") this.contexts.clear();
      }
      for (const listener of this.listeners) listener(method, params, sessionId);
    });
    await Effect.runPromise(
      Effect.addFinalizer(() => Effect.sync(unsubscribe)).pipe(Scope.provide(this.scope)),
    );
    await Effect.runPromise(
      Effect.acquireRelease(
        Effect.promise(() =>
          target.send("Emulation.setFocusEmulationEnabled", { enabled: true }, undefined),
        ),
        () =>
          Effect.promise(() =>
            target
              .send("Emulation.setFocusEmulationEnabled", { enabled: false }, undefined)
              .catch(() => undefined),
          ),
      ).pipe(Scope.provide(this.scope)),
    );
    const endpoint = await this.openEndpoint(target);
    // The manager retains the debugger between connections. Re-enabling Runtime
    // must announce existing contexts to this fresh Playwright connection.
    await target.send("Runtime.disable", {}, undefined);
    this.browser = await chromium.connectOverCDP(endpoint);
    this.browser.once("disconnected", () => {
      void this.close();
    });
    const pages = this.browser.contexts().flatMap((context) => context.pages());
    if (pages.length !== 1) throw new Error("Desktop tab relay requires exactly one page.");
    this.page = pages[0]!;
    this.page.once("close", () => {
      void this.close();
    });
    this.page.on("dialog", (dialog) => {
      if (this.ownsDialogs()) this.dialog = dialog;
    });
    this.lastViewport = await this.viewport();
    this.report();
  }

  private async openEndpoint(target: CdpRelayTarget, scope: Scope.Closeable = this.scope) {
    if (!target || this.closed) throw new BrowserControlInterrupted();
    const { contexts, listeners, closeClients } = this;
    const contextVersion = () => this.contextVersion;
    return Effect.runPromise(
      Effect.gen(function* () {
        const path = `/${NodeCrypto.randomBytes(24).toString("base64url")}`;
        let connected = false;
        const server = yield* NodeSocketServer.makeWebSocket({
          host: "127.0.0.1",
          port: 0,
          path,
          // Reject reuse during the HTTP upgrade. Closing a paused websocket
          // after accepting it leaves Playwright waiting for its CDP handshake.
          verifyClient: () => {
            if (connected) return false;
            connected = true;
            return true;
          },
        });
        yield* server
          .run((socket) =>
            Effect.gen(function* () {
              // NodeSocketServer supplies the native socket to each handler.
              const client = yield* Effect.withFiber((fiber) =>
                Effect.succeed(
                  Context.getUnsafe(fiber.context, Socket.WebSocket) as NodeWS.WebSocket,
                ),
              );
              // Rehosting must not wait for an abandoned script's close handshake.
              const close = () => client.terminate();
              closeClients.add(close);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  close();
                  closeClients.delete(close);
                }),
              );
              const output = yield* Queue.unbounded<string>();
              const runFork = Effect.runForkWith(yield* Effect.context<never>());
              const relay = createCdpRelayConnection(
                {
                  ...target,
                  send: async (method, params, sessionId) => {
                    const before = contextVersion();
                    const result = await target.send(method, params, sessionId);
                    // Runtime is shared by debugger clients. Chromium only announces existing
                    // contexts on the first enable; a new Playwright client needs them too.
                    if (method === "Runtime.enable" && !sessionId && before === contextVersion())
                      for (const context of contexts.values())
                        relay.event("Runtime.executionContextCreated", context, "");
                    return result;
                  },
                },
                (message) => {
                  runFork(Queue.offer(output, message));
                },
                close,
              );
              const listener = (method: string, params: unknown, sessionId: string) =>
                relay.event(method, params, sessionId);
              listeners.add(listener);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  listeners.delete(listener);
                }),
              );
              const writer = yield* socket.writer;
              const reader = yield* socket.reader;
              yield* Stream.fromQueue(output).pipe(
                Stream.runForEach((message) => writer.write(message)),
                Effect.forkScoped,
              );
              const decoder = new TextDecoder();
              return yield* reader.pull.pipe(
                Effect.flatMap((frames) =>
                  Effect.sync(() => {
                    for (const frame of frames)
                      relay.receive(typeof frame === "string" ? frame : decoder.decode(frame));
                  }),
                ),
                Effect.forever,
              );
            }).pipe(Effect.scoped, Effect.ignore),
          )
          .pipe(Effect.forkScoped);
        const address = server.address;
        if (address._tag !== "InetAddressV4")
          return yield* Effect.die("Unexpected desktop tab endpoint address.");
        return `ws://127.0.0.1:${address.port}${path}`;
      }).pipe(Scope.provide(scope)),
    );
  }

  private async assertScriptAllowed() {
    if (await PageOperations.credentialLocked(this.page!))
      throw new PageOperations.ServerBrowserOperationError({
        tag: "PreviewAutomationCredentialLockError",
        message: "Saved credentials block scripts in this document.",
      });
  }

  private async scriptEndpoint() {
    await this.assertScriptAllowed();
    const scope = Scope.makeUnsafe();
    this.publicEndpoints.add(scope);
    try {
      return await this.openEndpoint(this.target!, scope);
    } catch (error) {
      this.publicEndpoints.delete(scope);
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw error;
    }
  }

  private async revokePublicEndpoints() {
    const scopes = [...this.publicEndpoints];
    this.publicEndpoints.clear();
    await Promise.all(scopes.map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))));
  }

  /** Revoke raw CDP access before inserting a Vault value, under the agent action queue. */
  fillCredential<A>(insert: () => Promise<A>): Promise<A> {
    return this.control.system(async () => {
      await this.revokePublicEndpoints();
      return insert();
    });
  }

  private report() {
    this.changed(this.acting);
  }

  private ownsDialogs() {
    return (
      !this.closed &&
      (this.acting ||
        this.resolvingDialogs > 0 ||
        this.dialog !== null ||
        this.publicEndpoints.size > 0)
    );
  }

  close() {
    return (this.closing ??= this.shutdown());
  }

  private async shutdown() {
    this.closed = true;
    const draining = this.control.close();
    this.acting = false;
    this.report();
    await this.dialog?.dismiss().catch(() => undefined);
    this.dialog = null;
    for (const close of this.closeClients) close();
    await this.revokePublicEndpoints();
    await this.browser?.close();
    await Effect.runPromise(Scope.close(this.scope, Exit.void));
    await draining;
  }

  async respond(request: PreviewAutomationRequest): Promise<PreviewAutomationResponse> {
    const identity = {
      clientId: "desktop",
      connectionId: this.connectionId,
      requestId: request.requestId,
    };
    try {
      const result = await this.execute(request);
      // Pixels follow the same credential lock policy as server snapshots.
      if (request.operation === "snapshot") {
        const { screenshot, ...text } =
          result as import("@t3tools/contracts").PreviewAutomationSnapshot;
        return { ...identity, ok: true, result: { ...this.redact(text), screenshot } };
      }
      return {
        ...identity,
        ok: true,
        result: this.redact(redactSensitiveValues(result, [...this.secrets])),
      };
    } catch (cause) {
      const error = PageOperations.toOperationError(cause);
      return {
        ...identity,
        ok: false,
        error: {
          _tag: error.tag,
          message: "Desktop tab operation failed.",
          detail: this.redact(redactSensitiveValues(error.detail, [...this.secrets])),
        },
      };
    }
  }

  private async viewport(): Promise<{ width: number; height: number }> {
    const cdp = await this.page!.context().newCDPSession(this.page!);
    try {
      const { cssLayoutViewport } = await cdp.send("Page.getLayoutMetrics");
      this.lastViewport = {
        width: cssLayoutViewport.clientWidth,
        height: cssLayoutViewport.clientHeight,
      };
      return this.lastViewport;
    } finally {
      await cdp.detach();
    }
  }

  private async redactText<A>(value: A): Promise<A> {
    for (const secret of await PageOperations.sensitiveInputValues(this.page!))
      this.secrets.add(secret);
    return redactSensitiveValues(value, [...this.secrets]);
  }

  async execute(request: PreviewAutomationRequest): Promise<unknown> {
    const page = this.page;
    if (
      this.closed ||
      !page ||
      request.tabId !== this.binding.tabId ||
      request.threadId !== this.binding.threadId
    )
      throw new BrowserControlInterrupted({
        message: "This desktop tab belongs to another thread.",
        reason: "agentMismatch",
      });
    if (request.operation === "status") {
      const result = {
        available: true,
        visible: true,
        tabId: this.binding.tabId,
        url: page.url(),
        title: this.dialog ? this.target!.title() : await page.title(),
        loading: false,
        viewportSetting: this.setting,
        viewport: this.dialog ? this.lastViewport : await this.viewport(),
        dialog: this.dialog
          ? {
              type: this.dialog.type(),
              message: this.dialog.message(),
              defaultValue: this.dialog.defaultValue(),
            }
          : null,
        fileChooser: this.fileChooser
          ? {
              multiple: this.fileChooser.isMultiple(),
              accept: (await this.fileChooser.element().getAttribute("accept")) ?? "",
            }
          : null,
        control: {
          owner: this.acting ? "agent" : "unclaimed",
          ownedByCaller: true,
          generation: this.control.generation,
        },
        tabs: [
          {
            tabId: this.binding.tabId,
            url: page.url(),
            host: this.binding.deviceName,
            runtime: "desktop",
            owner: this.acting ? "agent" : "unclaimed",
          },
        ],
      };
      return this.dialog ? this.redact(result) : this.redactText(result);
    }
    if (request.operation === "credentialLock")
      return {
        tabId: this.binding.tabId,
        locked: await PageOperations.credentialLocked(page),
        available: true,
      };
    if (request.operation === "snapshot")
      return this.control.system(async () => {
        if (this.dialog)
          throw new BrowserControlInterrupted({
            message: "A browser dialog is pending. Read preview_status.",
            reason: "dialogPending",
          });
        const generation = this.control.generation;
        const cdp = await page.context().newCDPSession(page);
        try {
          // Check both sides of capture: a credential fill or disconnect may land while reading.
          const initiallyLocked = await PageOperations.credentialLocked(page);
          const snapshot = await PageOperations.snapshot({
            page,
            cdp,
            renderScale: (await page.evaluate("devicePixelRatio")) as number,
            consoleEntries: [],
            networkEntries: [],
            actionTimeline: [],
            includeScreenshot: !initiallyLocked,
            ...(this.target?.captureScreenshot
              ? { captureScreenshot: this.target.captureScreenshot }
              : {}),
          });
          const locked = await PageOperations.credentialLocked(page);
          const secrets = await PageOperations.sensitiveInputValues(page);
          for (const secret of secrets) this.secrets.add(secret);
          if (generation !== this.control.generation) throw new BrowserControlInterrupted();
          const { screenshot, ...text } = snapshot;
          return {
            ...redactSensitiveValues(text, [...this.secrets]),
            screenshot: locked ? { ...screenshot, data: "", width: 0, height: 0 } : screenshot,
          };
        } finally {
          await cdp.detach();
        }
      });
    // Dialog resolution must bypass a click waiting in the serial queue.
    if (request.operation === "dialog") {
      const input = decodeDialog(request.input);
      const dialog = this.dialog;
      if (!dialog) throw new Error("No dialog is pending.");
      this.resolvingDialogs++;
      try {
        if (input.accept) await dialog.accept(input.promptText);
        else await dialog.dismiss();
        if (this.dialog === dialog) this.dialog = null;
        return await this.execute({ ...request, operation: "status" });
      } finally {
        this.resolvingDialogs--;
      }
    }
    return this.control.agent(request.agentSessionId ?? "agent", async () => {
      if (this.dialog)
        throw new BrowserControlInterrupted({
          message: "A browser dialog is pending. Read preview_status and use preview_dialog first.",
          reason: "dialogPending",
        });
      await this.redactText(null);
      this.acting = true;
      this.report();
      const onFileChooser = (chooser: FileChooser) => {
        this.fileChooser = chooser;
      };
      const pendingChoosers: Promise<FileChooser>[] = [];
      const onCdpEvent = (method: string) => {
        if (method !== "Page.fileChooserOpened") return;
        const pending = page.waitForEvent("filechooser", { timeout: request.timeoutMs });
        pendingChoosers.push(pending);
        void pending.catch(() => {});
      };
      this.listeners.add(onCdpEvent);
      page.on("filechooser", onFileChooser);
      try {
        switch (request.operation) {
          case "navigate": {
            const input = decodeNavigate(request.input);
            const url = input.url ?? (input.target?.kind === "url" ? input.target.url : undefined);
            if (!url)
              throw new PageOperations.ServerBrowserOperationError({
                tag: "PreviewAutomationExecutionError",
                message: "Not supported on desktop tabs yet. Navigate with a URL.",
              });
            await page.goto(normalizePreviewUrl(url), {
              waitUntil: "domcontentloaded",
              timeout: request.timeoutMs,
            });
            return this.execute({ ...request, operation: "status" });
          }
          case "click":
            await PageOperations.click(page, decodeClick(request.input), this.pointer);
            break;
          case "type":
            await PageOperations.type(page, decodeType(request.input));
            break;
          case "hover":
            await PageOperations.hover(page, decodeHover(request.input), this.pointer);
            break;
          case "select":
            return this.redactText(await PageOperations.select(page, decodeSelect(request.input)));
          case "drag":
            await PageOperations.drag(page, decodeDrag(request.input), this.pointer);
            break;
          case "press":
            await PageOperations.press(page, decodePress(request.input));
            break;
          case "scroll":
            await PageOperations.scroll(page, decodeScroll(request.input));
            break;
          case "waitFor":
            await PageOperations.waitFor(page, decodeWaitFor(request.input));
            break;
          case "upload": {
            const input = decodeUpload(request.input);
            if (!(await PageOperations.setInputFiles(page, input))) {
              const chooser = this.fileChooser;
              if (!chooser)
                throw new Error(
                  "No file picker is open. Click the upload control first, or pass a file input locator.",
                );
              await chooser.setFiles([...input.paths], {
                timeout: input.timeoutMs ?? request.timeoutMs,
              });
              if (this.fileChooser === chooser) this.fileChooser = null;
            }
            break;
          }
          case "credentialFill": {
            await this.assertScriptAllowed();
            const cdp = await page.context().newCDPSession(page);
            try {
              return await PageOperations.fillCredential(
                page,
                cdp,
                request.input as PageOperations.CredentialFillRequest,
                (value) => this.secrets.add(value),
              );
            } finally {
              await cdp.detach();
            }
          }
          case "evaluate": {
            await this.assertScriptAllowed();
            const cdp = await page.context().newCDPSession(page);
            try {
              return await this.redactText(
                await PageOperations.evaluate(
                  cdp,
                  decodeEvaluate(request.input),
                  request.timeoutMs,
                ),
              );
            } finally {
              await cdp.detach();
            }
          }
          case "resize": {
            this.setting = resolvePreviewViewport(decodeResize(request.input));
            if (this.setting._tag === "fill") {
              const cdp = await page.context().newCDPSession(page);
              try {
                await cdp.send("Emulation.clearDeviceMetricsOverride");
              } finally {
                await cdp.detach();
              }
            } else
              await page.setViewportSize({
                width: this.setting.width,
                height: this.setting.height,
              });
            return {
              tabId: this.binding.tabId,
              setting: this.setting,
              viewport: await this.viewport(),
            };
          }
          case "setColorScheme": {
            this.colorScheme = decodeSetColorScheme(request.input).colorScheme;
            await page.emulateMedia({
              colorScheme: this.colorScheme === "system" ? null : this.colorScheme,
            });
            return { tabId: this.binding.tabId, colorScheme: this.colorScheme };
          }
          case "cdpEndpoint":
            return { tabId: this.binding.tabId, endpoint: await this.scriptEndpoint() };
          default:
            throw new PageOperations.ServerBrowserOperationError({
              tag: "PreviewAutomationExecutionError",
              message: `Not supported on desktop tabs: ${request.operation}.`,
            });
        }
        return {};
      } finally {
        try {
          // Playwright resolves the input element after the CDP event and click have returned.
          await Promise.all(pendingChoosers);
        } finally {
          this.listeners.delete(onCdpEvent);
          page.off("filechooser", onFileChooser);
          this.acting = false;
          this.report();
        }
      }
    });
  }
}
