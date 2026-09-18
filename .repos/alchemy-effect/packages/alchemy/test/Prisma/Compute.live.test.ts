import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import { getProject, getService } from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

const { test } = Test.make({ providers: Prisma.providers() });

const wantsLive = process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS === "true";
const hasLiveCredentials =
  process.env.ALCHEMY_RUN_LIVE_PRISMA_WITH_PROFILE === "true";
const runLive = wantsLive && hasLiveCredentials;
const wantsCleanup =
  process.env.ALCHEMY_RUN_LIVE_PRISMA_CLEANUP === "true" &&
  !!process.env.PRISMA_CLEANUP_PROJECT_ID?.trim();
const runCleanup = wantsCleanup && hasLiveCredentials;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

if (wantsLive && !hasLiveCredentials) {
  test(
    "requires Prisma credentials for the live Compute smoke",
    Effect.fail(
      new Error(
        [
          "Live Prisma Compute smoke requested but no credentials are configured.",
          "Run `alchemy profile edit --re-configure Prisma` and select `Service Token`,",
          "then rerun this live test with ALCHEMY_RUN_LIVE_PRISMA_TESTS=true.",
        ].join(" "),
      ),
    ),
  );
}

if (wantsCleanup && !hasLiveCredentials) {
  test(
    "requires Prisma credentials for existing Compute cleanup",
    Effect.fail(
      new Error(
        [
          "Live Prisma Compute cleanup requested but no credentials are configured.",
          "Run `alchemy profile edit --re-configure Prisma` and select `Service Token`.",
        ].join(" "),
      ),
    ),
  );
}

test.provider.skipIf(!runCleanup)(
  "live cleans up an existing Prisma Compute project/App from configured credentials",
  () =>
    Effect.gen(function* () {
      const projectId = process.env.PRISMA_CLEANUP_PROJECT_ID!.trim();
      const appId = process.env.PRISMA_CLEANUP_APP_ID?.trim() || undefined;
      const deploymentId =
        process.env.PRISMA_CLEANUP_DEPLOYMENT_ID?.trim() || undefined;

      if (deploymentId) {
        yield* Prisma.destroyDeployment(deploymentId, {
          timeoutSeconds: 240,
        });
      }
      yield* Prisma.destroyProjectApps(projectId, {
        timeoutSeconds: 240,
      });

      yield* expectGone("Prisma project", Prisma.getProject(projectId));
      if (appId) {
        yield* expectGone("Prisma App", Prisma.getApp(appId));
      }
    }).pipe(logLevel),
  { timeout: 600_000 },
);

test.provider.skipIf(!runLive)(
  "live deploys, reaches, and destroys a Prisma Compute app",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      yield* fs.writeFileString(
        path.join(appDir, "package.json"),
        ["{", '  "type": "module",', '  "main": "server.ts"', "}", ""].join(
          "\n",
        ),
      );
      yield* fs.writeFileString(
        path.join(appDir, "server.ts"),
        [
          'const port = Number(process.env["PORT"] ?? "8080");',
          "const server = Bun.serve({",
          "  port,",
          "  routes: {",
          '    "/": new Response(process.env["GREETING"] ?? "missing"),',
          '    "/health": Response.json({ ok: true }),',
          "  },",
          "});",
          "console.log(`Listening on ${server.url}`);",
          "export {};",
          "",
        ].join("\n"),
      );

      const suffix = yield* Effect.sync(() => Date.now().toString(36));
      const name = `alchemy-compute-${suffix}`;

      yield* stack.destroy();

      let deployed:
        | {
            projectId: string;
            appId: string;
            deploymentId: string;
          }
        | undefined;

      yield* Effect.gen(function* () {
        const output = yield* stack.deploy(
          Effect.gen(function* () {
            const project = yield* Prisma.Project("Project", {
              name,
              createDatabase: false,
            });
            const app = yield* Prisma.Compute("App", {
              project: project.projectId,
              appName: name,
              path: appDir,
              entrypoint: "server.ts",
              port: 8080,
              env: {
                GREETING: "hello from alchemy",
              },
              timeoutSeconds: 240,
              destroyOldDeployment: true,
            });
            return { project, app };
          }),
        );

        expect(output.project.projectId).toBeDefined();
        expect(output.app.appId).toBeDefined();
        expect(output.app.deploymentId).toBeDefined();
        expect(output.app.url).toBeDefined();
        deployed = {
          projectId: output.project.projectId,
          appId: output.app.appId,
          deploymentId: output.app.deploymentId!,
        };

        const text = yield* fetchText(`${output.app.url}/`);
        expect(text).toBe("hello from alchemy");
        yield* stack
          .destroy()
          .pipe(
            Effect.mapError(
              (error) =>
                new Error(
                  [
                    "Prisma Compute live smoke deployed successfully but destroy failed.",
                    `projectId=${deployed?.projectId}`,
                    `appId=${deployed?.appId}`,
                    `deploymentId=${deployed?.deploymentId}`,
                    deployed
                      ? [
                          "Retry cleanup after the platform fix with:",
                          "ALCHEMY_RUN_LIVE_PRISMA_WITH_PROFILE=true \\",
                          `PRISMA_CLEANUP_PROJECT_ID=${deployed.projectId} \\`,
                          `PRISMA_CLEANUP_APP_ID=${deployed.appId} \\`,
                          `PRISMA_CLEANUP_DEPLOYMENT_ID=${deployed.deploymentId} \\`,
                          "ALCHEMY_RUN_LIVE_PRISMA_CLEANUP=true bun vitest run packages/alchemy/test/Prisma/Compute.live.test.ts",
                        ].join(" ")
                      : undefined,
                  ]
                    .filter((line): line is string => line !== undefined)
                    .join(" "),
                  { cause: error },
                ),
            ),
          );
        yield* expectGone(
          "Prisma project",
          Prisma.getProject(deployed.projectId),
        );
        yield* expectGone("Prisma App", Prisma.getApp(deployed.appId));
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            yield* fs.remove(appDir, { recursive: true }).pipe(Effect.ignore);
          }),
        ),
      );
    }).pipe(logLevel),
  { timeout: 600_000 },
);

test.provider.skipIf(!runLive)(
  "live deploys, serves, and destroys a Prisma static site",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* path.fromFileUrl(
        new URL("./fixtures/compute-static-live/", import.meta.url),
      );
      const nodeModules = yield* path.fromFileUrl(
        new URL("../../node_modules/", import.meta.url),
      );
      const appDir = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-prisma-static-site-",
      });
      yield* fs.copy(fixture, appDir);
      yield* fs.symlink(nodeModules, path.join(appDir, "node_modules"));

      const deploy = (version: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Prisma.Project("Project", {
              createDatabase: false,
            });
            const site = yield* Prisma.Compute("Site", {
              project: project.projectId,
              path: appDir,
              build: {
                type: "auto",
                env: { VITE_SITE_VERSION: version },
                timeoutSeconds: 30,
              },
              healthCheck: { path: "/" },
              timeoutSeconds: 45,
              destroyOldDeployment: true,
            });
            return { project, site };
          }),
        );

      const verifySite = Effect.fn(function* (url: string, version: string) {
        const origin = url.replace(/\/$/, "");
        const index = yield* fs.readFileString(
          path.join(appDir, "dist/index.html"),
        );
        const script = yield* fs.readFileString(
          path.join(appDir, "dist/assets/app.js"),
        );
        const scriptStat = yield* fs.stat(
          path.join(appDir, "dist/assets/app.js"),
        );
        const docs = yield* fs.readFileString(
          path.join(appDir, "dist/docs/index.html"),
        );
        const docsStyle = yield* fs.readFileString(
          path.join(appDir, "dist/docs/style.css"),
        );
        expect(index).toContain("alchemy static shell");
        expect(index).toContain(`<p id="version">${version}</p>`);
        expect(script).toContain("alchemy static asset");

        yield* Effect.gen(function* () {
          const response = yield* HttpClient.get(`${origin}/`);
          const text = yield* response.text;
          if (response.status !== 200 || text !== index) {
            return yield* Effect.fail(
              new Error(
                `Static site ${version} is not ready (HTTP ${response.status})`,
              ),
            );
          }
        }).pipe(
          Effect.timeout("3 seconds"),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 8 }),
          Effect.timeout("15 seconds"),
        );

        const asset = yield* HttpClient.get(`${origin}/assets/app.js`);
        expect(asset.status).toBe(200);
        expect(asset.headers["content-type"]).toContain("javascript");
        expect(yield* asset.text).toBe(script);
        const head = yield* HttpClient.head(`${origin}/assets/app.js`);
        expect(head.status).toBe(200);
        expect(head.headers["content-length"]).toBe(String(scriptStat.size));
        expect(yield* head.text).toBe("");
        const route = yield* HttpClient.get(`${origin}/client/route`);
        expect(route.status).toBe(200);
        expect(yield* route.text).toBe(index);

        const query = "?from=%2Fclient%2Froute&next=%2F%2Fevil.example";
        for (const pathname of ["/docs", "//docs"]) {
          const redirect = yield* HttpClient.get(
            `${origin}${pathname}${query}`,
          );
          expect(redirect.status).toBe(301);
          expect(redirect.headers["location"]).toBe(`/docs/${query}`);
          const target = yield* Effect.sync(
            () => new URL(redirect.headers["location"]!, origin),
          );
          expect(target.origin).toBe(origin);
          expect(target.search).toBe(query);
          expect(decodeURIComponent(target.pathname).replace(/^\/+/, "/")).toBe(
            "/docs/",
          );
          yield* redirect.text;
          const directory = yield* HttpClient.get(target.href);
          expect(directory.status).toBe(200);
          expect(yield* directory.text).toBe(docs);
          const relativeAsset = yield* Effect.sync(
            () => new URL("./style.css", target).href,
          );
          const stylesheet = yield* HttpClient.get(relativeAsset);
          expect(stylesheet.status).toBe(200);
          expect(stylesheet.headers["content-type"]).toContain("text/css");
          expect(yield* stylesheet.text).toBe(docsStyle);
        }
      });

      yield* stack.destroy();
      yield* Effect.gen(function* () {
        const output = yield* deploy("v1");
        expect(output.site.url).toBeDefined();
        expect(output.site.deploymentId).toBeDefined();
        expect(
          (yield* getProject({ id: output.project.projectId })).data.id,
        ).toBe(output.project.projectId);
        expect(
          (yield* getService({ serviceId: output.site.appId })).data.id,
        ).toBe(output.site.appId);
        yield* verifySite(output.site.url!, "v1").pipe(
          Effect.timeout("20 seconds"),
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            cache: "no-store",
          }),
          Effect.provide(FetchHttpClient.layer),
        );

        const updated = yield* deploy("v2");
        expect(updated.project.projectId).toBe(output.project.projectId);
        expect(updated.site.appId).toBe(output.site.appId);
        expect(updated.site.url).toBe(output.site.url);
        expect(updated.site.deploymentId).toBeDefined();
        expect(updated.site.deploymentId).not.toBe(output.site.deploymentId);
        expect(
          (yield* getService({ serviceId: updated.site.appId })).data.id,
        ).toBe(updated.site.appId);
        yield* verifySite(updated.site.url!, "v2").pipe(
          Effect.timeout("20 seconds"),
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            cache: "no-store",
          }),
          Effect.provide(FetchHttpClient.layer),
        );

        yield* stack.destroy();
        const projectGone = yield* getProject({
          id: output.project.projectId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.repeat({
            until: (gone) => gone,
            schedule: Schedule.spaced("500 millis"),
            times: 8,
          }),
          Effect.timeout("10 seconds"),
        );
        const appGone = yield* getService({
          serviceId: output.site.appId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.repeat({
            until: (gone) => gone,
            schedule: Schedule.spaced("500 millis"),
            times: 8,
          }),
          Effect.timeout("10 seconds"),
        );
        expect(projectGone).toBe(true);
        expect(appGone).toBe(true);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)));
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!runLive)(
  "live rolls a Prisma App back to an existing deployment",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-rollback-",
      });
      yield* fs.writeFileString(
        path.join(appDir, "package.json"),
        ["{", '  "type": "module",', '  "main": "server.ts"', "}", ""].join(
          "\n",
        ),
      );
      yield* fs.writeFileString(
        path.join(appDir, "server.ts"),
        [
          'const port = Number(process.env["PORT"] ?? "8080");',
          "const server = Bun.serve({",
          "  port,",
          "  routes: {",
          '    "/": new Response(process.env["GREETING"] ?? "missing"),',
          '    "/health": Response.json({ ok: true }),',
          "  },",
          "});",
          "console.log(`Listening on ${server.url}`);",
          "export {};",
          "",
        ].join("\n"),
      );

      const suffix = yield* Effect.sync(() => Date.now().toString(36));
      const name = `alchemy-rollback-${suffix}`;

      yield* stack.destroy();

      yield* Effect.gen(function* () {
        const output = yield* stack.deploy(
          Effect.gen(function* () {
            const project = yield* Prisma.Project("Project", {
              name,
              createDatabase: false,
            });
            const app = yield* Prisma.Compute("App", {
              project: project.projectId,
              appName: name,
              path: appDir,
              entrypoint: "server.ts",
              port: 8080,
              env: { GREETING: "rollback target" },
              timeoutSeconds: 240,
              destroyOldDeployment: false,
            });
            return { project, app };
          }),
        );

        const appId = output.app.appId;
        const deploymentId = output.app.deploymentId;
        expect(appId).toBeDefined();
        expect(deploymentId).toBeDefined();

        // Roll the App back to its currently-live deployment. The control
        // plane accepts a roll to the live deployment (roll-forward / drift
        // heal) and returns the stable App endpoint plus the number of custom
        // domains reassigned (0 here, since none are attached). This drives
        // the canonical POST /v1/apps/{id}/rollback contract.
        const result = yield* Prisma.rollbackApp(appId, {
          deploymentId: deploymentId!,
        });
        expect(typeof result.appEndpointDomain).toBe("string");
        expect(result.appEndpointDomain.length).toBeGreaterThan(0);
        expect(result.reassignedDomains).toBe(0);

        const text = yield* fetchText(`${output.app.url}/`);
        expect(text).toBe("rollback target");

        yield* stack.destroy();
        const projectGone = yield* getProject({
          id: output.project.projectId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        );
        const appGone = yield* getService({ serviceId: appId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        );
        expect(projectGone).toBe(true);
        expect(appGone).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            yield* fs.remove(appDir, { recursive: true }).pipe(Effect.ignore);
          }),
        ),
      );
    }).pipe(logLevel),
  { timeout: 600_000 },
);

const fetchText = (url: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(HttpClientRequest.get(url));
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new Error(`Prisma Compute app returned HTTP ${response.status}`),
      );
    }
    return yield* response.text;
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.exponential(Duration.seconds(1)),
        Schedule.recurs(8),
      ]),
    }),
  );

const expectGone = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const gone = yield* effect.pipe(
      Effect.as(false),
      Effect.catchIf(Prisma.isNotFound, () => Effect.succeed(true)),
    );
    if (!gone) return yield* Effect.fail(new Error(`${label} still exists`));
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.exponential(Duration.seconds(1)),
        Schedule.recurs(8),
      ]),
    }),
  );
