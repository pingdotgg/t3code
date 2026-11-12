import { expect } from "@alchemy.run/test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { cloneFixture } from "../Cloudflare/Utils/Fixture.ts";

export type FoldkitMode = "spa" | "ssg" | "ssr" | "hybrid" | "static";
export const foldkitModes = ["spa", "ssg", "ssr", "hybrid"] as const;
/** Browser hydration checks need the `terminal-browser` CLI; opt in like the Neon suites. */
const browserEnabled = process.env.FOLDKIT_WEBSITE_BROWSER === "1";
export const foldkitMemo = {
  include: ["index.html", "src/**", "public/**", "package.json", "vite.config.ts"],
};

const cloudflareWebsite = (...segments: string[]) =>
  pathe.join(import.meta.dirname, "../Cloudflare/Website", ...segments);
const overlays = pathe.join(import.meta.dirname, "fixtures/foldkit-modes");

/** Copy an overlay directory over a fixture clone, replacing same-named files. */
const overlay = (
  from: string,
  to: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(from))) return;
    yield* fs.makeDirectory(to, { recursive: true });
    for (const entry of yield* fs.readDirectory(from)) {
      const source = pathe.join(from, entry);
      const target = pathe.join(to, entry);
      if ((yield* fs.stat(source)).type === "Directory") {
        yield* fs.makeDirectory(target, { recursive: true });
        yield* overlay(source, target);
      } else {
        yield* fs.writeFile(target, yield* fs.readFile(source));
      }
    }
  });

/**
 * A private clone of the Foldkit fixture for one rendering mode: the
 * client-only fixture for `spa`, otherwise the SSR fixture with the mode's
 * checked-in overlay (`fixtures/foldkit-modes/<mode>`) copied over it.
 */
export const foldkitFixture = (mode: FoldkitMode) =>
  Effect.gen(function* () {
    const root = yield* cloneFixture(
      cloudflareWebsite(mode === "spa" ? "foldkit-fixture" : "foldkit-ssr-fixture"),
      {
        prefix: `foldkit-${mode}-`,
        tempRoot: pathe.resolve(import.meta.dirname, "../../.tmp"),
        entries: [
          "package.json",
          "vite.config.ts",
          "src",
          ...(mode === "spa" ? ["index.html"] : []),
        ],
      },
    );
    if (mode === "spa") {
      yield* overlay(pathe.join(overlays, "common/public"), pathe.join(root, "public"));
    } else {
      yield* overlay(pathe.join(overlays, "common"), root);
      yield* overlay(pathe.join(overlays, mode), root);
    }
    return root;
  });

class RequestFailed extends Data.TaggedError("RequestFailed")<{ url: string; cause: unknown }> {}

const requestOnce = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(5000),
      });
      return {
        status: response.status,
        body: await response.text(),
        type: response.headers.get("content-type"),
      };
    },
    catch: (cause) => new RequestFailed({ url, cause }),
  });
class EdgePlaceholder extends Data.TaggedError("EdgePlaceholder")<{ url: string }> {}

/**
 * A fresh deployment can briefly answer from an edge node that has not
 * picked it up yet, with the CDN's own HTML error page (Cloudflare's
 * workers.dev placeholder). The app's own 404s are plain text, so retry only
 * the CDN's page (for bodiless HEAD responses: an HTML error).
 */
const request = (url: string, init?: RequestInit) =>
  requestOnce(url, init).pipe(
    Effect.flatMap((result) =>
      result.status >= 400 &&
      (init?.method === "HEAD"
        ? (result.type ?? "").includes("text/html")
        : result.body.includes("<!--[if lt IE 7]>"))
        ? Effect.fail(new EdgePlaceholder({ url }))
        : Effect.succeed(result),
    ),
    Effect.retry({
      while: (error) => error._tag === "EdgePlaceholder",
      schedule: Schedule.spaced("1 second"),
      times: 15,
    }),
  );

const routes = (mode: FoldkitMode) => [
  { path: "/?count=7", count: mode === "ssr" ? 7 : 0 },
  { path: "/about/?count=9", count: mode === "ssr" ? 9 : 0 },
  ...(mode === "static" || mode === "ssg"
    ? []
    : [{ path: "/counter/42?count=3", count: mode === "spa" ? 0 : 3 }]),
];

/** Exercise the public origin, including asset routing and the actual deployed SSR handler. */
export const verifyFoldkitRendering = (
  origin: string,
  mode: FoldkitMode,
  options: {
    /**
     * Where a POST to a prerendered page goes. Cloudflare's asset layer
     * answers non-GET/HEAD requests for a matching asset with 405 before
     * the Worker runs; other platforms forward them to the server.
     * @default "server"
     */
    prerenderedPost?: "server" | 405;
  } = {},
) =>
  Effect.gen(function* () {
    const base = origin.replace(/\/+$/, "");
    // Readiness: the asset layer and the server can go live at different
    // moments, so wait for both an asset and the first page. A redeploy
    // that changes which pages are prerendered also waits on the CDN's
    // routing data (CloudFront KeyValueStore propagation).
    const ready = (path: string, check: (body: string) => boolean) =>
      request(base + path).pipe(
        Effect.flatMap((result) =>
          result.status === 200 && check(result.body)
            ? Effect.void
            : Effect.fail(new Error(`Foldkit deployment is not serving ${path} yet`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 45 }),
      );
    yield* ready("/foldkit-probe.txt", (body) => body === "FOLDKIT_STATIC_ASSET");
    const first = routes(mode)[0]!;
    yield* ready(
      first.path,
      (body) => mode === "spa" || new RegExp(`id="count"[^>]*>${first.count}<`).test(body),
    );
    const assetHead = yield* request(`${base}/foldkit-probe.txt`, {
      method: "HEAD",
    });
    expect(assetHead.status).toBe(200);
    expect(assetHead.body).toBe("");
    for (const route of routes(mode)) {
      const response = yield* request(base + route.path);
      expect({ path: route.path, status: response.status }).toEqual({
        path: route.path,
        status: 200,
      });
      if (mode === "spa") {
        expect(response.body).toContain("Foldkit Fixture");
        expect(response.body).not.toMatch(/id="count"/);
      } else {
        expect(response.body).toMatch(new RegExp(`id="count"[^>]*>${route.count}<`));
      }
      const script = response.body.match(/<script[^>]+src="([^" ]+)"/);
      expect(script).not.toBeNull();
      const javascript = yield* request(new URL(script![1]!, base + route.path).href);
      expect(javascript.status).toBe(200);
      expect(javascript.type).toMatch(/javascript/);
      if (mode !== "spa") {
        const stylesheet = response.body.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/);
        expect(stylesheet).not.toBeNull();
        const css = yield* request(new URL(stylesheet![1]!, base + route.path).href);
        expect(css.status).toBe(200);
        expect(css.type).toMatch(/text\/css/);
      }
      const head = yield* request(base + route.path, { method: "HEAD" });
      expect({ head: route.path, status: head.status }).toEqual({
        head: route.path,
        status: 200,
      });
      expect(head.body).toBe("");
    }
    if (mode === "ssr" || mode === "hybrid") {
      const posted = yield* request(`${base}/about/?count=11`, {
        method: "POST",
        body: "request body",
      });
      if (mode === "hybrid" && options.prerenderedPost === 405) {
        expect(posted.status).toBe(405);
      } else {
        expect(posted.status).toBe(200);
        expect(posted.body).toMatch(/id="count"[^>]*>11</);
      }
      expect((yield* request(`${base}/assets/missing.js`)).status).toBe(404);
    }
    if (mode === "ssg") {
      expect((yield* request(`${base}/about/`, { method: "POST" })).status).toBe(405);
      expect((yield* request(`${base}/assets/missing.js`)).status).toBe(404);
    }
    if (mode === "static" || mode === "ssg")
      expect((yield* request(`${base}/not-prerendered`)).status).toBe(404);
  });

const browsers = Semaphore.makeUnsafe(1);
const command = (args: string[]) =>
  Effect.gen(function* () {
    const child = yield* ChildProcess.make("terminal-browser", args, {
      env: { ...process.env, NODE_OPTIONS: undefined },
    });
    const [code, stdout, stderr] = yield* Effect.all(
      [
        child.exitCode,
        child.stdout.pipe(Stream.decodeText, Stream.mkString),
        child.stderr.pipe(Stream.decodeText, Stream.mkString),
      ],
      { concurrency: 3 },
    );
    if (code !== 0) return yield* Effect.fail(new Error(`Browser command failed: ${stderr}`));
    return stdout;
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"));

/**
 * Hydration in a real browser: initial count, click, reload, click. A no-op
 * unless `FOLDKIT_WEBSITE_BROWSER=1`.
 */
export const verifyFoldkitBrowser = (origin: string, mode: FoldkitMode) =>
  Effect.gen(function* () {
    if (!browserEnabled) return;
    for (const route of routes(mode)) {
      yield* Effect.gen(function* () {
        const opened = yield* command(["new-tab", origin.replace(/\/+$/, "") + route.path]);
        const browser = yield* Effect.try(
          () =>
            JSON.parse(opened) as {
              key: string;
              openedTab?: number;
              tabs?: { id: number; active: boolean }[];
            },
        );
        const tab = browser.openedTab ?? browser.tabs?.find((tab) => tab.active)?.id;
        if (tab === undefined)
          return yield* Effect.fail(new Error("Browser did not report its active tab"));
        const action = (...args: string[]) =>
          command(["action", "--browser", browser.key, "--tab", String(tab), "--", ...args]);
        yield* Effect.addFinalizer(() =>
          action("close").pipe(
            Effect.andThen(
              command(["action", "--browser", browser.key, "--tab", String(tab), "done"]),
            ),
            Effect.ignore,
          ),
        );
        const countIs = (count: number) =>
          action(
            "eval",
            `document.readyState === "complete" && document.getElementById("count")?.textContent === ${JSON.stringify(String(count))} ? "FOLDKIT_COUNT_OK" : "WAITING"`,
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              times: 8,
              until: (text) => text.includes("FOLDKIT_COUNT_OK"),
            }),
            Effect.tap((text) => Effect.sync(() => expect(text).toContain("FOLDKIT_COUNT_OK"))),
          );
        yield* countIs(route.count);
        yield* action("click", "#increment");
        yield* countIs(route.count + 1);
        // A reload must hydrate the server's initial flags again, not retain the clicked state.
        yield* action("reload");
        yield* countIs(route.count);
        yield* action("click", "#increment");
        yield* countIs(route.count + 1);
      }).pipe(Effect.scoped);
    }
  }).pipe(browsers.withPermit, Effect.timeout("60 seconds"));
