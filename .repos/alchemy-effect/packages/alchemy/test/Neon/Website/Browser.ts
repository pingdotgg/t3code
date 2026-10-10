import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { initialCwd } from "@/Util/Node.ts";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

const command = Effect.fn(
  function* (args: string[]) {
    const child = yield* ChildProcess.make("terminal-browser", args, {
      env: { ...process.env, NODE_OPTIONS: undefined },
    });
    const [code, stdout, stderr] = yield* Effect.all(
      [
        child.exitCode,
        child.stdout.pipe(Stream.decodeText, Stream.mkString),
        child.stderr.pipe(Stream.decodeText, Stream.mkString),
      ],
      { concurrency: "unbounded" },
    );
    if (code !== 0)
      return yield* Effect.fail(new Error(`Browser command failed: ${stderr}`));
    return stdout;
  },
  Effect.scoped,
  Effect.timeout("10 seconds"),
);

const browsers = Semaphore.makeUnsafe(1);

/** Opt-in real terminal-browser interactions against each deployed or native app. */
export const browserRoundtrip = Effect.fn(
  function* (url: string, slug: string) {
    if (process.env.NEON_WEBSITE_BROWSER !== "1") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const screenshots = path.join(
      initialCwd,
      ".alchemy",
      "log",
      "website-browser",
    );
    yield* fs.makeDirectory(screenshots, { recursive: true });
    const opened = yield* command([
      "new-tab",
      slug === "vocs" ? `${url.replace(/\/+$/, "")}/counter` : url,
    ]);
    const browser = yield* Effect.try(
      () =>
        JSON.parse(opened) as {
          key: string;
          openedTab?: number;
          tabs?: { id: number; active: boolean }[];
        },
    );
    const openedTab =
      browser.openedTab ?? browser.tabs?.find((tab) => tab.active)?.id;
    if (openedTab === undefined)
      return yield* Effect.fail(
        new Error("Browser did not report its active tab"),
      );
    const tab = { key: browser.key, openedTab };
    const action = (...args: string[]) =>
      command([
        "action",
        "--browser",
        tab.key,
        "--tab",
        String(tab.openedTab),
        "--",
        ...args,
      ]);
    yield* Effect.addFinalizer(() =>
      action("eval", "location.href = 'about:blank'").pipe(
        Effect.andThen(action("close")),
        Effect.andThen(
          command([
            "action",
            "--browser",
            tab.key,
            "--tab",
            String(tab.openedTab),
            "done",
          ]),
        ),
        Effect.ignore,
      ),
    );
    for (const [width, height] of [
      [1280, 900],
      [390, 844],
    ]) {
      yield* action("set", "viewport", String(width), String(height));
      yield* action("reload");
      const label = slug === "foldkit" ? "+" : "count: 0";
      const snapshot = yield* action("snapshot", "-i").pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          times: 8,
          until: (text) => text.includes(label),
        }),
      );
      expect(snapshot).toContain(label);
      yield* action(
        "find",
        "role",
        "button",
        "click",
        "--name",
        label,
        "--exact",
      );
      if (slug === "foldkit") {
        expect(yield* action("get", "text", "#count")).toContain("1");
        yield* action(
          "find",
          "role",
          "button",
          "click",
          "--name",
          "Reset",
          "--exact",
        );
        expect(yield* action("get", "text", "#count")).toContain("0");
      } else {
        expect(yield* action("snapshot", "-i")).toContain("count: 1");
        if (!["vocs", "waku"].includes(slug)) {
          expect(snapshot).toContain("Load greeting");
          yield* action(
            "find",
            "role",
            "button",
            "click",
            "--name",
            "Load greeting",
            "--exact",
          );
          expect(
            yield* action(
              "get",
              "text",
              slug === "nextjs" ? 'section [role="status"]' : '[role="status"]',
            ).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("500 millis"),
                times: 8,
                until: (text) => text.includes("Hello from"),
              }),
            ),
          ).toContain("Hello from");
        }
      }
      if (slug === "nextjs") {
        yield* action("fill", "#name", `Neon visitor ${width}`);
        yield* action(
          "find",
          "role",
          "button",
          "click",
          "--name",
          "Submit name",
          "--exact",
        );
        expect(
          yield* action("get", "text", "body").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              times: 8,
              until: (text) =>
                text.includes(`Submitted: Neon visitor ${width}`),
            }),
          ),
        ).toContain(`Submitted: Neon visitor ${width}`);
        yield* action("reload");
        expect(yield* action("get", "text", "body")).toContain(
          `Submitted: Neon visitor ${width}`,
        );
      }
      expect(
        yield* action(
          "eval",
          "document.documentElement.scrollWidth <= window.innerWidth",
        ),
      ).toContain("true");
      yield* action(
        "screenshot",
        path.join(
          screenshots,
          `${slug}-${url.startsWith("https:") ? "live" : "local"}-${width}.png`,
        ),
      );
      if (["astro", "nuxt", "sveltekit", "waku"].includes(slug)) {
        const route = slug === "astro" ? "/about/" : "/about";
        yield* action("click", `a[href="${route}"]`);
        expect(yield* action("get", "url")).toContain("/about");
        yield* action("reload");
        expect(yield* action("get", "text", "body")).toContain("prerendered");
        yield* action("back");
      }
      if (slug === "vocs") {
        const base = url.replace(/\/+$/, "");
        for (const [route, heading] of [
          ["/guide", "Deployment guide"],
          ["/", "Alchemy with Vocs"],
        ]) {
          yield* action(
            "click",
            `nav[aria-label="Pagination"] a[href="${route}"]`,
          );
          const headingText = action("get", "text", "h1").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (text) => text.includes(heading),
            }),
            Effect.timeout("10 seconds"),
          );
          expect(yield* headingText).toContain(heading);
          yield* action("reload");
          expect(yield* headingText).toContain(heading);
        }
        yield* action("back");
        expect(yield* action("get", "url")).toContain("/guide");
        yield* action(
          "eval",
          `location.href = ${JSON.stringify(`${base}/counter`)}`,
        );
      }
      yield* Effect.logInfo(
        `Website browser ${slug} ${width}x${height}: passed`,
      );
    }
  },
  Effect.scoped,
  browsers.withPermit,
);
