import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectResponse } from "../Utils/Http.ts";
import { expectWorkerExists, waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

// The create-cloudflare (C3) templates built on `@cloudflare/vite-plugin`,
// as generated, deployed and under `alchemy dev`. Each keeps the official
// `cloudflare()` call in its Vite config, which alchemy neutralizes.

const { test } = Test.make({ providers: Cloudflare.providers() });
const { test: devTest } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

interface Template {
  name: string;
  fixture: string;
  entries: Array<string>;
  props: Omit<Cloudflare.Website.ViteProps, "rootDir">;
  check: (url: string) => Effect.Effect<void, unknown>;
}

// The SPA templates: the HTML shell and its script, the Worker's `/api/`
// route, and the SPA fallback for client-side routes.
const checkSpaWithApi = (mountId: string) => (url: string) =>
  Effect.gen(function* () {
    let script: string | undefined;
    yield* expectResponse(url, (res) => {
      if (res.status !== 200 || !res.body.includes(`<div id="${mountId}">`))
        return `${res.status} ${res.body.slice(0, 300)}`;
      script = res.body.match(/<script type="module"[^>]* src="(\/[^"]+)"/)?.[1];
      return script ? undefined : `no module script in ${res.body.slice(0, 300)}`;
    });
    yield* expectResponse(`${url}${script}`, (res) =>
      res.status === 200 ? undefined : `script ${res.status} ${res.body.slice(0, 200)}`,
    );
    yield* expectResponse(`${url}/api/`, (res) =>
      res.status === 200 && res.body === `{"name":"Cloudflare"}`
        ? undefined
        : `api ${res.status} ${res.body.slice(0, 200)}`,
    );
    // A browser navigation: other requests for unknown paths reach the Worker.
    yield* expectResponse(
      `${url}/client/route`,
      (res) =>
        res.status === 200 && res.body.includes(`<div id="${mountId}">`)
          ? undefined
          : `fallback ${res.status} ${res.body.slice(0, 200)}`,
      { headers: { "sec-fetch-mode": "navigate" } },
    );
  });

// A server-rendered page and the same-origin stylesheet it links.
const expectSsrPage = (url: string, text: string) =>
  Effect.gen(function* () {
    let stylesheet: string | undefined;
    yield* expectResponse(url, (res) => {
      if (res.status !== 200 || !res.body.includes(text))
        return `${res.status} ${res.body.slice(0, 300)}`;
      stylesheet = res.body.match(/rel="stylesheet" href="(\/[^"]+)"/)?.[1];
      return stylesheet
        ? undefined
        : `no stylesheet link in ${JSON.stringify(res.body.match(/<link[^>]*>/g))}`;
    });
    // Tailwind v4's output (minified builds drop its banner).
    yield* expectResponse(new URL(stylesheet!.replaceAll("&amp;", "&"), url).toString(), (res) =>
      res.status === 200 && /tailwindcss|@layer properties/.test(res.body)
        ? undefined
        : `css ${res.status} ${res.body.slice(0, 200)}`,
    );
  });

const TEMPLATES: ReadonlyArray<Template> = [
  {
    // `npm create cloudflare -- --framework=vike`: create-vike's React
    // starter, whose Worker entry is the virtual module `vike:server`.
    name: "vike",
    fixture: "vite-vike-template-fixture",
    entries: [
      "package.json",
      "vite.config.ts",
      "wrangler.jsonc",
      "tsconfig.json",
      "assets",
      "components",
      "pages",
    ],
    props: {
      main: "vike:server",
      compatibility: { date: "2026-03-12" },
    },
    check: (url) =>
      Effect.gen(function* () {
        let stylesheet: string | undefined;
        yield* expectResponse(url, (res) => {
          if (res.status !== 200 || !res.body.includes("<h1>My Vike app</h1>"))
            return `${res.status} ${res.body.slice(0, 300)}`;
          stylesheet = res.body.match(/rel="stylesheet"[^>]* href="(\/[^"]+)"/)?.[1];
          return stylesheet ? undefined : `no stylesheet in ${res.body.slice(0, 300)}`;
        });
        yield* expectResponse(`${url}${stylesheet}`, (res) =>
          res.status === 200 ? undefined : `css ${res.status} ${res.body.slice(0, 200)}`,
        );
        // A page whose `+data` hook runs on the server.
        yield* expectResponse(`${url}/todo`, (res) =>
          res.status === 200 && res.body.includes("Buy strawberries")
            ? undefined
            : `todo ${res.status} ${res.body.slice(0, 200)}`,
        );
      }),
  },
  {
    // `npm create cloudflare -- --framework=redwood`: create-rwsdk's
    // starter, server components rendered in the `worker` environment.
    name: "redwood",
    fixture: "vite-redwood-template-fixture",
    entries: [
      "package.json",
      "vite.config.mts",
      "wrangler.jsonc",
      "tsconfig.json",
      "public",
      "src",
      "types",
    ],
    props: {
      main: "./src/worker.tsx",
      compatibility: { date: "2025-08-21", flags: ["nodejs_compat"] },
      viteEnvironments: { entry: "worker" },
    },
    check: (url) =>
      Effect.gen(function* () {
        let script: string | undefined;
        yield* expectResponse(url, (res) => {
          if (res.status !== 200 || !res.body.includes("Welcome to RedwoodSDK"))
            return `${res.status} ${res.body.slice(0, 300)}`;
          // The client entry, imported by an inline script.
          script = res.body.match(/rel="modulepreload" href="(\/[^"]+)"/)?.[1];
          return script ? undefined : `no client script in ${res.body.slice(0, 600)}`;
        });
        yield* expectResponse(`${url}${script}`, (res) =>
          res.status === 200 ? undefined : `script ${res.status} ${res.body.slice(0, 200)}`,
        );
        yield* expectResponse(`${url}/favicon-light.svg`, (res) =>
          res.status === 200 ? undefined : `favicon ${res.status}`,
        );
      }),
  },
  {
    // `npm create cloudflare -- --framework=tanstack-start`: the
    // `@tanstack/cli` Cloudflare starter, whose Worker entry is a package
    // export, with Tailwind CSS and the TanStack devtools plugin.
    name: "tanstack-start",
    fixture: "vite-tanstack-start-template-fixture",
    entries: [
      "package.json",
      "vite.config.ts",
      "wrangler.jsonc",
      "tsconfig.json",
      "tsr.config.json",
      "src",
    ],
    props: {
      main: "@tanstack/react-start/server-entry",
      compatibility: { date: "2025-09-02", flags: ["nodejs_compat"] },
    },
    check: (url) =>
      Effect.gen(function* () {
        yield* expectSsrPage(url, "Start simple, ship quickly.");
        yield* expectResponse(`${url}/about`, (res) =>
          res.status === 200 && res.body.includes("<title>TanStack Start Starter</title>")
            ? undefined
            : `about ${res.status} ${res.body.slice(0, 200)}`,
        );
      }),
  },
  {
    // `npm create cloudflare -- --framework=react`: create-vite's
    // `react-ts` with a Worker for `/api/`.
    name: "react",
    fixture: "vite-react-template-fixture",
    entries: [
      "package.json",
      "vite.config.ts",
      "wrangler.jsonc",
      "index.html",
      "public",
      "src",
      "worker",
    ],
    props: {
      main: "./worker/index.ts",
      compatibility: { date: "2025-10-08" },
      assets: { notFoundHandling: "single-page-application" },
    },
    check: checkSpaWithApi("root"),
  },
  {
    // `npm create cloudflare -- --framework=vue`: create-vue with the
    // router, TypeScript and Vue DevTools, and a Worker for `/api/`.
    name: "vue",
    fixture: "vite-vue-template-fixture",
    entries: [
      "package.json",
      "vite.config.ts",
      "wrangler.jsonc",
      "env.d.ts",
      "index.html",
      "public",
      "src",
      "server",
    ],
    props: {
      main: "./server/index.ts",
      compatibility: { date: "2025-10-08" },
      assets: { notFoundHandling: "single-page-application" },
    },
    check: checkSpaWithApi("app"),
  },
  {
    // `npm create cloudflare -- --framework=react-router`: SSR through
    // `createRequestHandler`, a loader reading `env` from
    // `cloudflare:workers`, and Tailwind CSS.
    name: "react-router",
    fixture: "vite-react-router-fixture",
    entries: [
      "package.json",
      "vite.config.ts",
      "wrangler.jsonc",
      "react-router.config.ts",
      "app",
      "public",
      "workers",
    ],
    props: {
      main: "./workers/app.ts",
      compatibility: { date: "2025-10-08" },
      env: { VALUE_FROM_CLOUDFLARE: "Hello from Cloudflare" },
    },
    check: (url) =>
      Effect.gen(function* () {
        let stylesheet: string | undefined;
        yield* expectResponse(url, (res) => {
          if (res.status !== 200) return `status ${res.status} ${res.body.slice(0, 300)}`;
          if (!res.body.includes("Hello from Cloudflare")) return `body ${res.body.slice(0, 300)}`;
          // Built: the hashed bundle. Dev: React Router's critical CSS.
          stylesheet = res.body.match(/rel="stylesheet" href="(\/[^"]+)"/)?.[1];
          return stylesheet
            ? undefined
            : `no stylesheet link in ${JSON.stringify(res.body.match(/<link[^>]*>/g))}`;
        });
        yield* expectResponse(
          new URL(stylesheet!.replaceAll("&amp;", "&"), url).toString(),
          (res) =>
            res.status === 200 && res.body.includes("tailwindcss")
              ? undefined
              : `css ${res.status} ${res.body.slice(0, 200)}`,
        );
        yield* expectResponse(`${url}/favicon.ico`, (res) =>
          res.status === 200 ? undefined : `favicon ${res.status}`,
        );
        yield* expectResponse(`${url}/missing`, (res) =>
          res.status === 404 && res.body.includes("The requested page could not be found.")
            ? undefined
            : `missing ${res.status} ${res.body.slice(0, 200)}`,
        );
      }),
  },
];

describe("Website.Vite templates", () => {
  for (const template of TEMPLATES) {
    for (const mode of ["live", "dev"] as const) {
      const id = `ViteTemplate${mode}${template.name.replace(/(^|-)(\w)/g, (_, _dash, c: string) => c.toUpperCase())}`;
      (mode === "live" ? test : devTest).provider(
        `Vite template: ${template.name}${mode === "dev" ? " (dev)" : ""}`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* cloneFixture(
              pathe.resolve(import.meta.dirname, template.fixture),
              {
                prefix: `alchemy-vite-template-${template.name}-`,
                tempRoot,
                entries: template.entries,
              },
            );
            const site = yield* stack.deploy(
              Cloudflare.Website.Vite(id, {
                ...template.props,
                rootDir,
                workersDev: true,
                memo: { include: ["**/*"] },
                ...(mode === "dev" ? { dev: { port: 0 } } : {}),
              }),
            );
            const url = site.url!.replace(/\/$/, "");
            yield* template.check(url);
            if (mode === "live") {
              const { accountId } = yield* yield* CloudflareEnvironment;
              yield* expectWorkerExists(site.workerName, accountId);
              yield* stack.destroy();
              yield* waitForWorkerToBeDeleted(site.workerName, accountId);
            }
          }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
        {
          tags: ["provider:cloudflare:worker", mode === "dev" ? "local" : "live"],
          timeout: 300_000,
        },
      );
    }
  }
});
