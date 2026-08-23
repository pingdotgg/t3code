import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// The app already registers the t3code:// scheme (Info.plist on macOS, the
// Clerk bridge's setAsDefaultProtocolClient, the .desktop entry on Linux) and
// already routes one URL family: Clerk's OAuth callback. Everything else was
// accepted by the OS, delivered to the app and dropped, so opening a thread
// link raised the window and left it wherever it happened to be.
//
// The relay already emits exactly this shape for its push notifications
// (`deepLink: "/threads/<environmentId>/<threadId>"`) and the mobile app routes
// it, so a link that opens a chat on the phone should open the same chat here
// rather than being a second, desktop-only format.
const THREAD_HOST = "threads";
const THREAD_PATH_SEGMENT = "threads";

// Both ids are UUIDs everywhere they are minted (thread ids in the orchestrator,
// environment ids in the environment descriptor), and requiring that shape is
// what makes this parse TOTAL rather than merely plausible.
//
// It is a security boundary, not a formatting preference. A URL handler is an
// unauthenticated entry point: any local process can hand the app a t3code://
// URL. Without a shape constraint, `t3code://threads/settings/connections`
// resolves to the two-segment path `/settings/connections`, which is a real
// static route and wins over `/$environmentId/$threadId`, so anything on the
// machine could silently drive the window onto a settings page. A UUID pair can
// never collide with a static route.
//
// It also makes the parse strictly narrower than the mobile app's, which closes
// the cases where WHATWG normalisation would otherwise let something through
// that `normalizeThreadDeepLink` rejects (`//`, a trailing slash, a `..`
// segment): none of those survive as a UUID.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { logInfo, logWarning } = makeComponentLogger("desktop-url-routing");

export interface ThreadDeepLink {
  readonly environmentId: string;
  readonly threadId: string;
}

/**
 * The renderer path a thread deep link resolves to.
 *
 * The web routes a chat as `/$environmentId/$threadId` (see
 * `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`), WITHOUT the
 * `threads/` prefix the incoming URL carries. The prefix exists in the link
 * because that is what the mobile router and the relay payload use; translating
 * it here keeps that one difference in one place.
 */
export function threadRoutePath(link: ThreadDeepLink): string {
  return `/${encodeURIComponent(link.environmentId)}/${encodeURIComponent(link.threadId)}`;
}

/**
 * Parse `t3code://threads/<environmentId>/<threadId>`, or `null` if the URL is
 * anything else.
 *
 * `null` is the normal answer, not an error: every `open-url` listener sees
 * every URL delivered to the app, including Clerk's OAuth callbacks, so this
 * has to decline politely rather than warn.
 *
 * Strictness is modelled on the mobile app's `normalizeThreadDeepLink`
 * (`apps/mobile/src/features/agent-awareness/notificationPayload.ts`) and is
 * deliberately **at least as strict**, never looser: no query, no fragment, no
 * credentials, exactly two segments, and both of them UUIDs. Being looser is
 * what would matter, because a link the phone accepts and the desktop rejects
 * is a bug with nothing to say which side is wrong; the reverse is only a
 * narrower door. Mobile splits the raw string while this goes through WHATWG
 * parsing, which normalises `//`, a trailing slash and `..` away, so the UUID
 * requirement is what keeps those from becoming an accidental widening.
 *
 * One divergence is accepted knowingly: `t3code://threads/../<env>/<thread>`
 * is normalised by WHATWG parsing before this sees it, so it is accepted here
 * and rejected by mobile, which splits the raw string. It resolves to the same
 * thread, so the door is not wider in any meaningful sense; matching mobile
 * there would mean re-parsing the raw string by hand for no gain.
 *
 * Both authority forms are accepted because both are what people actually
 * produce: `t3code://threads/a/b` puts `threads` in the host, while
 * `t3code:///threads/a/b` leaves the host empty and puts it in the path.
 */
export function parseThreadDeepLink(rawUrl: string, scheme: string): ThreadDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== `${scheme}:`) return null;
  if (url.search !== "" || url.hash !== "") return null;
  // Credentials in the authority would make `t3code://user@threads/a/b` parse
  // with host "threads"; the mobile parser never sees an authority at all.
  if (url.username !== "" || url.password !== "") return null;

  // Split without discarding empties, exactly as the mobile parser does, so an
  // extra or trailing slash is a rejection rather than something normalised
  // quietly away. Filtering empty segments here was looser than mobile and is
  // the kind of asymmetry this parser exists to avoid.
  const parts = url.pathname.split("/");
  const rest =
    url.host === THREAD_HOST
      ? parts.length === 3 && parts[0] === ""
        ? parts.slice(1)
        : null
      : url.host === "" && parts.length === 4 && parts[0] === "" && parts[1] === THREAD_PATH_SEGMENT
        ? parts.slice(2)
        : null;

  if (rest === null) return null;

  let environmentId: string;
  let threadId: string;
  try {
    environmentId = decodeURIComponent(rest[0] ?? "");
    threadId = decodeURIComponent(rest[1] ?? "");
  } catch {
    return null;
  }

  if (!UUID_PATTERN.test(environmentId) || !UUID_PATTERN.test(threadId)) return null;
  return { environmentId, threadId };
}

/**
 * The action string carried over the existing menu-action channel.
 *
 * Deliberately reusing that channel rather than adding a new one: it already
 * exists on both sides, its payload is a plain string, and `dispatchMenuAction`
 * already solves everything hard about delivery (create the window if there is
 * none, wait for `did-finish-load` if the renderer is still booting, reveal the
 * window afterwards). A second channel would duplicate all of it.
 */
export const NAVIGATE_ACTION_PREFIX = "navigate:";

export function navigateAction(path: string): string {
  return `${NAVIGATE_ACTION_PREFIX}${path}`;
}

/**
 * URLs the OS delivered before the service existed, and the collector that
 * catches them.
 *
 * Electron's guidance is to register `open-url` **early in application
 * startup**, because "if you register the listener in response to a `ready`
 * event, you'll miss URLs that trigger the launch of your application". Nothing
 * in Electron buffers them. Registering inside the Effect startup is not early
 * enough: by then the whole layer graph is built and the shell environment, the
 * user-data path, the settings load and the Clerk bootstrap have each awaited,
 * every one of which yields to the run loop where the launch event is
 * dispatched.
 *
 * So the listener that catches a launch parks raw strings and nothing else, and
 * `register` drains them once there is something able to route.
 */
const launchUrls: string[] = [];
let stopCapturingLaunchUrls: (() => void) | null = null;

/**
 * Start collecting `open-url` events immediately. Call once, synchronously,
 * from the process entrypoint before any async work happens.
 *
 * Takes the app rather than importing electron, so this module stays importable
 * in tests without an Electron runtime.
 */
export function captureLaunchUrlsSync(app: Electron.App): void {
  if (stopCapturingLaunchUrls !== null) return;
  const listener = (_event: Electron.Event, url: string) => {
    launchUrls.push(url);
  };
  app.on("open-url", listener);
  stopCapturingLaunchUrls = () => app.removeListener("open-url", listener);
}

export class DesktopUrlRouting extends Context.Service<
  DesktopUrlRouting,
  {
    /** Install the `open-url` listener. Scoped: the listener dies with the app scope. */
    readonly register: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/app/DesktopUrlRouting") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<DesktopWindow.DesktopWindow>();
  const runPromise = Effect.runPromiseWith(context);

  const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);

  const handleUrl = Effect.fn("desktop.urlRouting.handleUrl")(function* (rawUrl: string) {
    const link = parseThreadDeepLink(rawUrl, scheme);
    if (link === null) {
      // Not ours. Clerk's OAuth callback arrives on the same event and is
      // handled by its own listener, so silence is correct here.
      return;
    }
    const path = threadRoutePath(link);
    yield* logInfo("routing thread deep link", {
      environmentId: link.environmentId,
      threadId: link.threadId,
    });
    yield* desktopWindow.dispatchMenuAction(navigateAction(path)).pipe(
      // A deep link must never take the app down: the window layer already logs
      // its own failures, and an unroutable link is a no-op, not a fatal
      // condition. `catchCause`, not `catch`: the latter covers only the typed
      // error channel, so a DEFECT under window creation would escape it, reach
      // the `runPromise` below as an unhandled rejection and take the main
      // process with it.
      Effect.catchCause((cause) =>
        logWarning("failed to route thread deep link", { cause: String(cause) }),
      ),
    );
  });

  const register = Effect.gen(function* () {
    // `open-url` is macOS only. Windows and Linux deliver the URL as argv to a
    // second instance, which the Clerk bridge's single-instance lock already
    // forwards; wiring that path is a separate change and is deliberately not
    // guessed at here.
    yield* electronApp.on<[Electron.Event, string]>("open-url", (event, url) => {
      // preventDefault only for URLs that are ours, so Clerk's listener still
      // sees its own callbacks untouched.
      if (parseThreadDeepLink(url, scheme) !== null) {
        event.preventDefault();
      }
      // The Effect absorbs its own failures; this guards the promise boundary
      // itself, where an unhandled rejection is fatal to the main process.
      void runPromise(handleUrl(url)).catch(() => {});
    });

    // Hand over from the bootstrap collector, in this order: the real listener
    // is live BEFORE the collector goes away, so nothing falls between the two.
    // A URL arriving in that overlap is routed twice, which is one navigation
    // to the same thread and therefore harmless.
    stopCapturingLaunchUrls?.();
    stopCapturingLaunchUrls = null;
    const buffered = launchUrls.splice(0, launchUrls.length);
    for (const url of buffered) {
      yield* handleUrl(url);
    }

    yield* logInfo("url routing registered", { scheme, buffered: buffered.length });
  }).pipe(Effect.withSpan("desktop.urlRouting.register"));

  return DesktopUrlRouting.of({ register });
});

export const layer = Layer.effect(DesktopUrlRouting, make);
