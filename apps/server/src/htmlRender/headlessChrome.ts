import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { publicProxy } from "./publicProxy.ts";

export class HtmlRenderBrowserError extends Schema.TaggedError<HtmlRenderBrowserError>()(
  "HtmlRenderBrowserError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Headless Chrome could not render the page: ${this.reason}.`;
  }
}

/** The browser died at startup because this host cannot give it a sandbox. */
export class HtmlRenderSandboxUnavailableError extends Schema.TaggedError<HtmlRenderSandboxUnavailableError>()(
  "HtmlRenderSandboxUnavailableError",
  {},
) {
  override get message(): string {
    return "Chrome's sandbox is unavailable on this host.";
  }
}

type BrowserFailure = HtmlRenderBrowserError | HtmlRenderSandboxUnavailableError;

export interface ConsoleMessage {
  readonly level: "log" | "info" | "warning" | "error";
  readonly text: string;
}

const MAX_CONSOLE_MESSAGES = 20;
const MAX_CONSOLE_TEXT_CHARS = 500;
const VIEWPORT_HEIGHT = 800;
const MAX_CAPTURE_HEIGHT = 4_000;
const CAPTURE_TIMEOUT = "20 seconds";
// Pages load from this made-up web origin, never from a file. Chrome refuses
// local files to every web page, frame, worker, and popup, so a page cannot
// read files the agent's provider withholds; local images reach it already
// inlined as data URIs. `.localhost` keeps it a secure context that may still
// load plain-http resources, and the request never leaves the browser.
// All of the browser's traffic goes through `publicProxy`, which only reaches
// public addresses, so a page cannot reach this machine's local network. The
// main frame also stays on the page and the browser opens no popups, so a
// capture always shows the page itself.
const PAGE_ORIGIN = "http://t3-page.localhost";
const PAGE_URL = `${PAGE_ORIGIN}/page.html`;
// Stack traces and load errors name the page this way instead of its URL.
const PAGE_NAME = "page.html";
// Each measuring load reads its own copy of the page off the pipe.
const MEASURE_CONCURRENCY = 3;

const textEncoder = new TextEncoder();

/**
 * A page as the base64 bytes `PAGE_URL` serves, encoded once however often it
 * loads. Node's encoder, since pages run to 25 MiB.
 */
const pageBody = (html: string) =>
  Buffer.from(Buffer.from(html, "utf8").toString("base64"), "latin1");
// What Chrome prints before aborting when it cannot sandbox itself, e.g. on
// Ubuntu 23.10+ where AppArmor restricts unprivileged user namespaces.
const NO_SANDBOX_SIGNATURE = "No usable sandbox";

const CdpMessage = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Number),
    method: Schema.optional(Schema.String),
    sessionId: Schema.optional(Schema.String),
    params: Schema.optional(Schema.Unknown),
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ message: Schema.String })),
  }),
);
const decodeCdpMessage = Schema.decodeUnknownOption(CdpMessage);
const encodeCdpCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const RemoteObject = Schema.Struct({
  type: Schema.String,
  value: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
});
const decodeConsoleApiCalled = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.String, args: Schema.Array(RemoteObject) }),
);
const decodeExceptionThrown = Schema.decodeUnknownOption(
  Schema.Struct({
    exceptionDetails: Schema.Struct({
      text: Schema.String,
      exception: Schema.optional(RemoteObject),
    }),
  }),
);
const decodeRequestPaused = Schema.decodeUnknownOption(
  Schema.Struct({
    requestId: Schema.String,
    request: Schema.Struct({ url: Schema.String }),
    frameId: Schema.optional(Schema.String),
    resourceType: Schema.optional(Schema.String),
  }),
);
const decodeLogEntryAdded = Schema.decodeUnknownOption(
  Schema.Struct({
    entry: Schema.Struct({
      level: Schema.String,
      text: Schema.String,
      url: Schema.optional(Schema.String),
    }),
  }),
);

const remoteObjectText = (value: typeof RemoteObject.Type) =>
  typeof value.value === "string"
    ? value.value
    : (value.description ?? (value.value === undefined ? value.type : String(value.value)));

const CONSOLE_LEVELS: Readonly<Record<string, ConsoleMessage["level"]>> = {
  log: "log",
  debug: "log",
  dir: "log",
  dirxml: "log",
  table: "log",
  trace: "log",
  info: "info",
  warning: "warning",
  error: "error",
  assert: "error",
};

/** Everything the page logs, uncaught exceptions, and the browser's own load errors. */
const consoleMessageFromEvent = (method: string, params: unknown): ConsoleMessage | undefined => {
  if (method === "Runtime.consoleAPICalled") {
    const event = Option.getOrUndefined(decodeConsoleApiCalled(params));
    const level = event === undefined ? undefined : CONSOLE_LEVELS[event.type];
    return event && level ? { level, text: event.args.map(remoteObjectText).join(" ") } : undefined;
  }
  if (method === "Runtime.exceptionThrown") {
    const details = Option.getOrUndefined(decodeExceptionThrown(params))?.exceptionDetails;
    return details
      ? { level: "error", text: details.exception?.description ?? details.text }
      : undefined;
  }
  if (method === "Log.entryAdded") {
    const entry = Option.getOrUndefined(decodeLogEntryAdded(params))?.entry;
    return entry && (entry.level === "error" || entry.level === "warning")
      ? { level: entry.level, text: entry.url ? `${entry.text} ${entry.url}` : entry.text }
      : undefined;
  }
  return undefined;
};

// Resolves after web fonts load and two frames paint, so late layout lands in the capture.
const SETTLE_EXPRESSION =
  "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))";
// The root's scroll height never drops below the viewport, so a short page
// reports its own box height instead.
const MEASURE_EXPRESSION =
  "(() => { const root = document.documentElement; return root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height; })()";

const Ignored = Schema.Unknown;
const Navigation = Schema.Struct({ errorText: Schema.optional(Schema.String) });
const Measured = Schema.Struct({ result: Schema.Struct({ value: Schema.Finite }) });

interface PageEvents {
  /** The page's main frame, which only ever shows `PAGE_URL`. */
  readonly mainFrameId: string;
  /** The page served for `PAGE_URL`, from `pageBody`. */
  body: Uint8Array | undefined;
  loaded: Deferred.Deferred<void, BrowserFailure> | undefined;
  readonly consoleMessages: Array<ConsoleMessage>;
  omittedConsoleMessages: number;
}

/**
 * Starts the headless shell for the life of the scope, speaking CDP over
 * `--remote-debugging-pipe` (fd 3 in, fd 4 out, NUL-delimited JSON). Scope
 * close kills the process group. Each page is its own target, so pages load
 * in parallel.
 */
const launchBrowser = Effect.fnUntraced(function* (input: {
  readonly executable: string;
  readonly noSandbox: boolean;
  readonly profileDirectory: string;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const proxyPort = yield* publicProxy;
  const outgoing = yield* Queue.unbounded<Uint8Array>();
  const child = yield* spawner
    .spawn(
      ChildProcess.make(
        input.executable,
        [
          "--headless=new",
          "--remote-debugging-pipe",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-gpu",
          "--hide-scrollbars",
          "--mute-audio",
          "--block-new-web-contents",
          `--proxy-server=socks5://127.0.0.1:${proxyPort}`,
          // Loopback would otherwise skip the proxy.
          "--proxy-bypass-list=<-loopback>",
          // WebRTC would otherwise send UDP, which no proxy carries.
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          ...(input.noSandbox ? ["--no-sandbox"] : []),
          `--user-data-dir=${input.profileDirectory}`,
          "about:blank",
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          forceKillAfter: "2 seconds",
          additionalFds: {
            fd3: { type: "input", stream: Stream.fromQueue(outgoing) },
            fd4: { type: "output" },
          },
        },
      ),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new HtmlRenderBrowserError({ reason: "the browser could not be started", cause }),
      ),
    );

  let stderrTail = "";
  let sandboxUnavailable = false;
  const stderrReader = yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.sync(() => {
        stderrTail = (stderrTail + text).slice(-1_024);
        if (stderrTail.includes(NO_SANDBOX_SIGNATURE)) sandboxUnavailable = true;
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  const pending = new Map<
    number,
    { readonly method: string; readonly reply: Deferred.Deferred<unknown, BrowserFailure> }
  >();
  const pages = new Map<string, PageEvents>();
  let disconnected: BrowserFailure | undefined;
  let nextId = 0;

  // A command whose reply nobody awaits; `receive` drops replies without a waiter.
  const post = (method: string, params: Record<string, unknown>, sessionId: string) =>
    Queue.offer(
      outgoing,
      new TextEncoder().encode(
        `${encodeCdpCommand({ id: ++nextId, method, params, sessionId })}\0`,
      ),
    ).pipe(Effect.asVoid);

  // Serves the page. Its body is shared bytes between two small JSON halves,
  // queued together, so loading a page of up to 25 MiB at several widths never
  // copies it on this side.
  const fulfillPage = (sessionId: string, requestId: string, body: Uint8Array) =>
    Queue.offerAll(outgoing, [
      textEncoder.encode(
        `{"id":${++nextId},"sessionId":${JSON.stringify(sessionId)},"method":"Fetch.fulfillRequest","params":{"requestId":${JSON.stringify(requestId)},"responseCode":200,"responseHeaders":[{"name":"Content-Type","value":"text/html; charset=utf-8"}],"body":"`,
      ),
      body,
      textEncoder.encode('"}}\0'),
    ]).pipe(Effect.asVoid);

  const receive = (raw: string) => {
    const message = Option.getOrUndefined(decodeCdpMessage(raw));
    if (message?.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (!waiter) return Effect.void;
      return message.error
        ? Deferred.fail(
            waiter.reply,
            new HtmlRenderBrowserError({
              reason: `${waiter.method} failed`,
              cause: message.error.message,
            }),
          )
        : Deferred.succeed(waiter.reply, message.result);
    }
    const sessionId = message?.sessionId;
    const page = sessionId === undefined ? undefined : pages.get(sessionId);
    if (sessionId === undefined || !page || !message?.method) return Effect.void;
    if (message.method === "Page.loadEventFired") {
      return page.loaded ? Deferred.succeed(page.loaded, undefined) : Effect.void;
    }
    if (message.method === "Fetch.requestPaused") {
      const paused = Option.getOrUndefined(decodeRequestPaused(message.params));
      if (!paused) return Effect.void;
      const body = page.body;
      const url = paused.request.url.split("#", 1)[0]!;
      if (url === PAGE_URL && body !== undefined) {
        return fulfillPage(sessionId, paused.requestId, body);
      }
      // A frame inside the page may show another site; Local Network Access
      // still covers it. The main frame and T3's own origin serve nothing else.
      const otherSiteFrame =
        paused.resourceType === "Document" &&
        paused.frameId !== page.mainFrameId &&
        !url.startsWith(`${PAGE_ORIGIN}/`);
      return otherSiteFrame
        ? post("Fetch.continueRequest", { requestId: paused.requestId }, sessionId)
        : post(
            "Fetch.failRequest",
            { requestId: paused.requestId, errorReason: "AccessDenied" },
            sessionId,
          );
    }
    const consoleMessage = consoleMessageFromEvent(message.method, message.params);
    if (!consoleMessage) return Effect.void;
    if (page.consoleMessages.length >= MAX_CONSOLE_MESSAGES) {
      page.omittedConsoleMessages += 1;
      return Effect.void;
    }
    const text = consoleMessage.text.replaceAll(PAGE_URL, PAGE_NAME);
    page.consoleMessages.push({
      level: consoleMessage.level,
      text:
        text.length > MAX_CONSOLE_TEXT_CHARS ? `${text.slice(0, MAX_CONSOLE_TEXT_CHARS)}…` : text,
    });
    return Effect.void;
  };

  // The pipe closes when the browser exits. A sandbox abort says why on
  // stderr, which may still be draining, so give it a moment.
  const disconnect = Effect.gen(function* () {
    yield* Fiber.await(stderrReader).pipe(Effect.timeout("1 second"), Effect.ignore);
    const error = sandboxUnavailable
      ? new HtmlRenderSandboxUnavailableError()
      : new HtmlRenderBrowserError({ reason: "the browser exited unexpectedly" });
    disconnected = error;
    const waiters = [...pending.values()];
    pending.clear();
    yield* Effect.forEach(waiters, ({ reply }) => Deferred.fail(reply, error), { discard: true });
    yield* Effect.forEach(
      pages.values(),
      (page) => (page.loaded ? Deferred.fail(page.loaded, error) : Effect.void),
      { discard: true },
    );
  });

  // Decoded text chunks may split a message anywhere, and a screenshot reply spans many.
  let partial: Array<string> = [];
  yield* child.getOutputFd(4).pipe(
    Stream.decodeText(),
    Stream.runForEach((text) => {
      const complete: Array<string> = [];
      let start = 0;
      for (let end = text.indexOf("\0"); end !== -1; end = text.indexOf("\0", start)) {
        partial.push(text.slice(start, end));
        complete.push(partial.join(""));
        partial = [];
        start = end + 1;
      }
      if (start < text.length) partial.push(text.slice(start));
      return Effect.forEach(complete, receive, { discard: true });
    }),
    Effect.ignore,
    // Interruption means the scope is closing on purpose; only an exit disconnects.
    Effect.andThen(disconnect),
    Effect.forkScoped,
  );

  const send = <A>(
    method: string,
    params: Record<string, unknown>,
    result: Schema.Decoder<A>,
    sessionId?: string,
  ) =>
    Effect.gen(function* () {
      if (disconnected) return yield* disconnected;
      const id = ++nextId;
      const reply = yield* Deferred.make<unknown, BrowserFailure>();
      pending.set(id, { method, reply });
      const message = encodeCdpCommand({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      yield* Queue.offer(outgoing, new TextEncoder().encode(`${message}\0`));
      return yield* Deferred.await(reply).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(result)),
        Effect.mapError((error) =>
          error._tag === "HtmlRenderBrowserError" ||
          error._tag === "HtmlRenderSandboxUnavailableError"
            ? error
            : new HtmlRenderBrowserError({
                reason: `${method} returned an unexpected result`,
                cause: error,
              }),
        ),
      );
    });

  /** A fresh page at `width`; each `load` navigates it and measures the settled layout. */
  const openPage = Effect.fnUntraced(function* (width: number) {
    const { targetId } = yield* send(
      "Target.createTarget",
      { url: "about:blank" },
      Schema.Struct({ targetId: Schema.String }),
    );
    const { sessionId } = yield* send(
      "Target.attachToTarget",
      { targetId, flatten: true },
      Schema.Struct({ sessionId: Schema.String }),
    );
    const events: PageEvents = {
      // A page target's id is its main frame's id.
      mainFrameId: targetId,
      body: undefined,
      loaded: undefined,
      consoleMessages: [],
      omittedConsoleMessages: 0,
    };
    pages.set(sessionId, events);
    yield* send("Page.enable", {}, Ignored, sessionId);
    yield* send("Runtime.enable", {}, Ignored, sessionId);
    yield* send("Log.enable", {}, Ignored, sessionId);
    // Previews have no use for WebRTC, whose ICE servers can make the browser
    // resolve names outside the proxy. Runs before page scripts in every frame.
    yield* send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: "delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;",
        runImmediately: true,
      },
      Ignored,
      sessionId,
    );
    // Pauses T3's own origin, to serve the page, and every document, to keep
    // the main frame on it.
    yield* send(
      "Fetch.enable",
      {
        patterns: [
          { urlPattern: `${PAGE_ORIGIN}/*` },
          { urlPattern: "*", resourceType: "Document" },
        ],
      },
      Ignored,
      sessionId,
    );
    yield* send(
      "Emulation.setDeviceMetricsOverride",
      { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
      Ignored,
      sessionId,
    );

    /** Loads a page from `pageBody`, so callers loading it often encode it once. */
    const load = Effect.fnUntraced(function* (body: Uint8Array, urlFragment: string) {
      const loaded = yield* Deferred.make<void, BrowserFailure>();
      events.body = body;
      events.loaded = loaded;
      const navigation = yield* send(
        "Page.navigate",
        { url: `${PAGE_URL}${urlFragment}` },
        Navigation,
        sessionId,
      );
      if (navigation.errorText) {
        return yield* new HtmlRenderBrowserError({ reason: "the page could not be opened" });
      }
      yield* Deferred.await(loaded);
      yield* send(
        "Runtime.evaluate",
        { expression: SETTLE_EXPRESSION, awaitPromise: true },
        Ignored,
        sessionId,
      );
      const measured = yield* send(
        "Runtime.evaluate",
        { expression: MEASURE_EXPRESSION, returnByValue: true },
        Measured,
        sessionId,
      );
      return Math.max(0, Math.ceil(measured.result.value));
    });

    const screenshot = (height: number) =>
      send(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        },
        Schema.Struct({ data: Schema.String }),
        sessionId,
      ).pipe(Effect.map(({ data }) => data));

    const consoleMessages = (): ReadonlyArray<ConsoleMessage> =>
      events.omittedConsoleMessages === 0
        ? [...events.consoleMessages]
        : [
            ...events.consoleMessages,
            {
              level: "warning",
              text: `${events.omittedConsoleMessages} more console messages were omitted.`,
            },
          ];

    // Frees the page in the browser once it is no longer needed.
    const close = send("Target.closeTarget", { targetId }, Ignored).pipe(
      Effect.ensuring(Effect.sync(() => pages.delete(sessionId))),
      Effect.ignore,
    );

    return { load, screenshot, consoleMessages, close };
  });

  return { openPage };
});

/** A temporary directory for the browser profile, removed with the scope. */
const scratchDirectory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.acquireRelease(
    fileSystem.makeTempDirectory({ prefix: "t3-html-preview-" }),
    (directory) => fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new HtmlRenderBrowserError({ reason: "a temporary directory could not be created", cause }),
    ),
  );
});

/** Loads `html` at `width` and returns a PNG of the top of the page. */
export const captureHtmlScreenshot = Effect.fn("headlessChrome.captureHtmlScreenshot")(
  function* (input: {
    readonly executable: string;
    readonly noSandbox: boolean;
    readonly html: string;
    readonly width: number;
    readonly urlFragment: string;
  }) {
    const path = yield* Path.Path;
    const directory = yield* scratchDirectory;
    const browser = yield* launchBrowser({
      executable: input.executable,
      noSandbox: input.noSandbox,
      profileDirectory: path.join(directory, "profile"),
    });
    const page = yield* browser.openPage(input.width);
    const contentHeight = yield* page.load(pageBody(input.html), input.urlFragment);
    const capturedHeight = Math.max(1, Math.min(contentHeight, MAX_CAPTURE_HEIGHT));
    const png = yield* page.screenshot(capturedHeight);
    return { png, contentHeight, capturedHeight, consoleMessages: page.consoleMessages() };
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: CAPTURE_TIMEOUT,
    orElse: () =>
      Effect.fail(
        new HtmlRenderBrowserError({
          reason: `the page did not finish loading within ${CAPTURE_TIMEOUT}`,
        }),
      ),
  }),
);

/**
 * Content heights of the page at each width, each from a fresh load, since
 * pages often lay themselves out from the width once at load. One browser,
 * a few widths at a time.
 */
export const measureHtmlHeights = Effect.fn("headlessChrome.measureHtmlHeights")(function* (input: {
  readonly executable: string;
  readonly noSandbox: boolean;
  readonly html: string;
  readonly widths: ReadonlyArray<number>;
  readonly urlFragment: string;
}) {
  const path = yield* Path.Path;
  const directory = yield* scratchDirectory;
  const browser = yield* launchBrowser({
    executable: input.executable,
    noSandbox: input.noSandbox,
    profileDirectory: path.join(directory, "profile"),
  });
  const body = pageBody(input.html);
  return yield* Effect.forEach(
    input.widths,
    (width) =>
      browser.openPage(width).pipe(
        Effect.flatMap((page) =>
          page.load(body, input.urlFragment).pipe(Effect.ensuring(page.close)),
        ),
        Effect.map((height) => [width, height] as const),
      ),
    { concurrency: MEASURE_CONCURRENCY },
  );
}, Effect.scoped);
