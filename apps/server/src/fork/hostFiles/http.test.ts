import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter } from "effect/http";

import * as AssetSigner from "../../assets/AssetSigner.ts";
import * as NativeAppIconResolver from "../../assets/NativeAppIconResolver.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerHttp from "../../http.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as BuiltInDrivers from "../../sourceControl/builtInDrivers.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as HostFiles from "./HostFiles.ts";
import * as HostFilesHttp from "./http.ts";

const SESSION_SCOPES: Readonly<Record<string, ReadonlyArray<AuthEnvironmentScope>>> = {
  "Bearer reader": [AuthFilesystemReadScope],
  "Bearer viewer": [AuthOrchestrationReadScope],
};
const READER = { authorization: "Bearer reader" };
const ADDRESS_BAR = { ...READER, "sec-fetch-site": "none" };
const SANDBOX = "allow-scripts allow-forms allow-popups allow-downloads";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const layerAuth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  authenticateHttpRequest: (request) => {
    const scopes = SESSION_SCOPES[request.headers.authorization ?? ""];
    return scopes === undefined
      ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError())
      : Effect.succeed({
          sessionId: AuthSessionId.make("test"),
          subject: "test",
          method: "bearer-access-token" as const,
          scopes,
        });
  },
});

// Upstream's asset route sits beside the grant route; no test request reaches these lookups.
const layerUnusedAssetServices = Layer.mergeAll(
  Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.succeed(BuiltInDrivers.SourceControlDrivers, []),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
);

const layerTest = ServerConfig.layerTest(process.cwd(), { prefix: "t3-host-files-http-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** Serves a root holding `files` beside the app's asset and `*` routes; the server's state dir is inside it. */
const serve = Effect.fn("HostFilesHttpTest.serve")(function* (
  files: Readonly<Record<string, string | Uint8Array>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const root = config.baseDir;
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, ...name.split("/"));
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* typeof content === "string"
      ? fileSystem.writeFileString(file, content)
      : fileSystem.writeFile(file, content);
  }
  const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-host-files-app-" });
  yield* fileSystem.writeFileString(path.join(staticDir, "index.html"), "<html>app</html>");
  const fileRoot = HostFiles.toFileRoot(path, root);
  const policy = yield* HostFiles.makePolicy([fileRoot]);
  // Route handlers read their services from the request context, not from the route layer.
  const services = yield* Layer.build(
    Layer.mergeAll(
      layerAuth,
      layerUnusedAssetServices,
      AssetSigner.layer.pipe(Layer.provideMerge(ServerSecretStore.layer)),
    ).pipe(
      Layer.provideMerge(ServerConfig.layer({ ...config, staticDir })),
      Layer.provideMerge(
        Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer, NodeCrypto.layer),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(
      HostFilesHttp.layerWithPolicy(policy),
      ServerHttp.layerAssetRoute,
      ServerHttp.layerStaticAndDevRoute,
    ).pipe(Layer.provide(Layer.succeedContext(services))),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const get = (urlPath: string, headers?: Record<string, string>) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://t3.test${urlPath}`, headers ? { headers } : {}),
        services,
      );
      return { response, body: new Uint8Array(await response.arrayBuffer()) };
    });
  return {
    root,
    config,
    url: (name: string) => `${fileRoot.urlPrefix}/${name}`,
    get,
  };
});

const text = (body: Uint8Array) => new TextDecoder().decode(body);

const frameSrc = (body: Uint8Array) => {
  const frames = [...text(body).matchAll(/<iframe src="([^"]+)" sandbox="([^"]+)"/g)];
  expect(frames).toHaveLength(1);
  expect(frames[0]?.[2]).toBe(SANDBOX);
  return frames[0]?.[1] ?? "";
};

const openLink = (body: Uint8Array) => {
  expect(text(body)).not.toContain("<iframe");
  expect(text(body)).not.toContain("/api/assets/");
  return /<a href="([^"]+)">Open /.exec(text(body))?.[1] ?? "";
};

const sibling = (src: string, name: string) => `${src.slice(0, src.lastIndexOf("/"))}/${name}`;

describe("host file routes", () => {
  it.effect("a signed-out browser gets one sign-in page whether or not the file exists", () =>
    Effect.gen(function* () {
      const server = yield* serve({ "home/secret.txt": "top secret", "home/docs/a.txt": "" });
      const existing = yield* server.get(server.url("home/secret.txt"));
      const missing = yield* server.get(server.url("home/missing.txt"));
      const folder = yield* server.get(server.url("home/docs"));

      expect([existing.response.status, missing.response.status, folder.response.status]).toEqual([
        401, 401, 401,
      ]);
      expect(text(existing.body)).toBe(text(missing.body));
      expect(text(folder.body)).toBe(text(missing.body));
      expect(text(existing.body)).not.toContain("top secret");
      expect(existing.response.headers.get("cache-control")).toBe("no-store");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a session without filesystem:read is forbidden", () =>
    Effect.gen(function* () {
      const server = yield* serve({ "home/secret.txt": "top secret" });
      const { response, body } = yield* server.get(server.url("home/secret.txt"), {
        authorization: "Bearer viewer",
      });

      expect(response.status).toBe(403);
      expect(text(body)).not.toContain("top secret");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("text of any extension shows as plain text, also behind a :line:col suffix", () =>
    Effect.gen(function* () {
      const server = yield* serve({
        "home/src/app.ts": "export const a = 1;\n",
        "home/src/app.js": "alert(1)\n",
        "home/notes:7": "named with a colon",
      });
      for (const name of ["home/src/app.ts", "home/src/app.ts:3:1", "home/src/app.ts:3"]) {
        const { response, body } = yield* server.get(server.url(name), READER);
        expect(response.status, name).toBe(200);
        expect(response.headers.get("content-type"), name).toBe("text/plain; charset=utf-8");
        expect(text(body), name).toBe("export const a = 1;\n");
      }
      const script = yield* server.get(server.url("home/src/app.js"), READER);
      const named = yield* server.get(server.url("home/notes:7"), READER);

      expect(script.response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(script.response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(script.response.headers.get("cache-control")).toBe("no-store");
      expect(script.response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; sandbox",
      );
      expect(text(named.body)).toBe("named with a colon");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("media keeps its type and other binary files download", () =>
    Effect.gen(function* () {
      const server = yield* serve({
        "home/a.png": PNG,
        "home/d.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
        "home/x.bin": new Uint8Array([1, 0, 2]),
      });
      const image = yield* server.get(server.url("home/a.png"), READER);
      const svg = yield* server.get(server.url("home/d.svg"), READER);
      const binary = yield* server.get(server.url("home/x.bin"), READER);

      expect(image.response.headers.get("content-type")).toBe("image/png");
      expect(image.body).toEqual(PNG);
      expect(svg.response.headers.get("content-security-policy")).toContain("sandbox");
      expect(binary.response.headers.get("content-type")).toBe("application/octet-stream");
      expect(binary.response.headers.get("content-disposition")).toContain("attachment");
      expect(binary.response.headers.get("cache-control")).toBe("no-store");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("hidden names and the server's own files are not found", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* serve({
        "home/visible.txt": "ok",
        "home/.env": "TOKEN=1",
        "home/.git/config": "[core]",
      });
      const { stateDir, secretsDir } = server.config;
      const internal = [
        path.join(secretsDir, "probe"),
        path.join(stateDir, "settings.json"),
        path.join(stateDir, "logs", "server.trace.ndjson"),
      ];
      for (const file of internal) yield* fileSystem.writeFileString(file, "state");
      const urlOf = (file: string) => path.relative(server.root, file).split(path.sep).join("/");
      const listing = yield* server.get(server.url(""), READER);

      expect((yield* server.get(server.url("home/visible.txt"), READER)).response.status).toBe(200);
      for (const name of [
        "home/.env",
        "home/.git/config",
        ...internal.map(urlOf),
        urlOf(stateDir),
      ]) {
        const { response, body } = yield* server.get(server.url(name), READER);
        expect(response.status, name).toBe(404);
        expect(text(body), name).not.toContain("app");
      }
      expect(text(listing.body)).toContain('href="./home/"');
      expect(text(listing.body)).not.toContain(path.basename(stateDir));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "a link opens what it points to, unless that is hidden or T3's state",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const server = yield* serve({
          "home/.private/key.txt": "private key",
          "home/reports/report.html": "<img src=fig.png>",
          "home/reports/fig.png": PNG,
        });
        const at = (name: string) => path.join(server.root, ...name.split("/"));
        yield* fileSystem.writeFileString(path.join(server.config.stateDir, "settings.json"), "{}");
        yield* fileSystem.symlink(at("home/.private/key.txt"), at("home/key.txt"));
        yield* fileSystem.symlink(server.config.stateDir, at("home/t3"));
        yield* fileSystem.symlink(at("home/reports/report.html"), at("home/shortcut.html"));
        const key = yield* server.get(server.url("home/key.txt"), READER);
        const state = yield* server.get(server.url("home/t3/settings.json"), READER);
        const listing = text((yield* server.get(server.url("home/"), READER)).body);
        const page = yield* server.get(server.url("home/shortcut.html"), ADDRESS_BAR);
        const src = frameSrc(page.body);

        expect(key.response.status).toBe(404);
        expect(text(key.body)).not.toContain("private key");
        expect(state.response.status).toBe(404);
        expect(listing).toContain('href="./shortcut.html"');
        expect(listing).toContain('href="./reports/"');
        expect(listing).not.toContain("key.txt");
        expect(listing).not.toContain('href="./t3/"');
        expect(src).toMatch(/\/report\.html$/);
        expect((yield* server.get(sibling(src, "fig.png"))).body).toEqual(PNG);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a folder redirects to its slash form and lists visible entries, folders first", () =>
    Effect.gen(function* () {
      const server = yield* serve({
        "home/docs/b.txt": "b",
        "home/docs/sub/c.txt": "c",
        "home/docs/.hidden": "h",
        "home/docs/<x>.txt": "x",
      });
      const bare = yield* server.get(server.url("home/docs"), READER);
      const listing = yield* server.get(server.url("home/docs/"), READER);
      const html = text(listing.body);

      expect(bare.response.status).toBe(302);
      expect(bare.response.headers.get("location")).toBe("./docs/");
      expect(listing.response.status).toBe(200);
      expect(listing.response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(listing.response.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );
      expect(html.indexOf('href="./sub/"')).toBeGreaterThan(-1);
      expect(html.indexOf('href="./sub/"')).toBeLessThan(html.indexOf('href="./b.txt"'));
      expect(html).toContain('href="./%3Cx%3E.txt">&lt;x&gt;.txt</a>');
      expect(html).not.toContain("<x>");
      expect(html).not.toContain(".hidden");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a folder with an index.html shows it framed", () =>
    Effect.gen(function* () {
      const server = yield* serve({ "home/site/index.html": "<h1>site</h1>" });
      const page = yield* server.get(server.url("home/site/"), ADDRESS_BAR);
      const src = frameSrc(page.body);
      const framed = yield* server.get(src);

      expect(src).toMatch(/^\/api\/assets\/host-files\/[^/]+\/index\.html$/);
      expect(text(framed.body)).toBe("<h1>site</h1>");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("an HTML report shows sandboxed, and its relative files load with no credentials", () =>
    Effect.gen(function* () {
      const server = yield* serve({
        "home/reports/report.html": "<link rel=stylesheet href=style.css><img src=fig.png>",
        "home/reports/fig.png": PNG,
        "home/reports/style.css": "body{}",
        "home/reports/.private.png": PNG,
        "home/reports/old.htm": "<p>old</p>",
      });
      const page = yield* server.get(server.url("home/reports/report.html"), ADDRESS_BAR);
      const src = frameSrc(page.body);
      const report = yield* server.get(src);
      const old = yield* server.get(sibling(src, "old.htm"));
      const figure = yield* server.get(sibling(src, "fig.png"));
      const style = yield* server.get(sibling(src, "style.css"));
      const hidden = yield* server.get(sibling(src, ".private.png"));

      expect(page.response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; frame-src *; frame-ancestors 'self'",
      );
      expect(text(page.body)).not.toContain("<script");
      expect(src).toMatch(/^\/api\/assets\/host-files\/[^/]+\/report\.html$/);
      expect(report.response.status).toBe(200);
      expect(report.response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      for (const html of [report, old]) {
        expect(html.response.headers.get("content-type")).toBe("text/html; charset=utf-8");
        const policy = html.response.headers.get("content-security-policy");
        expect(policy?.startsWith(`sandbox ${SANDBOX}; `)).toBe(true);
        expect(policy).toContain("connect-src data: blob:");
      }
      expect(report.response.headers.get("cache-control")).toBe("no-store");
      expect(text(report.body)).toBe("<link rel=stylesheet href=style.css><img src=fig.png>");
      expect(figure.response.headers.get("content-type")).toBe("image/png");
      expect(figure.body).toEqual(PNG);
      expect(style.response.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(hidden.response.status).toBe(404);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a report directly in a root shows, but its neighbours do not load", () =>
    Effect.gen(function* () {
      const server = yield* serve({ "top.html": "<img src=fig.png>", "fig.png": PNG });
      const page = yield* server.get(server.url("top.html"), ADDRESS_BAR);
      const src = frameSrc(page.body);

      expect((yield* server.get(src)).response.status).toBe(200);
      expect((yield* server.get(sibling(src, "fig.png"))).response.status).toBe(404);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("only T3 itself, the address bar, or the Open page's signed link gets a grant", () =>
    Effect.gen(function* () {
      const server = yield* serve({
        "home/reports/report.html": "<p>report</p>",
        "home/reports/other.html": "<p>other</p>",
      });
      const url = server.url("home/reports/report.html");
      const visit = (site: string | undefined, target = url) =>
        server.get(target, site === undefined ? READER : { ...READER, "sec-fetch-site": site });

      for (const site of ["same-origin", "none"]) {
        expect(frameSrc((yield* visit(site)).body), site).toContain("/api/assets/host-files/");
      }
      for (const site of ["cross-site", "same-site", undefined]) {
        const { response, body } = yield* visit(site);
        expect(response.status, site).toBe(200);
        expect(openLink(body), site).toMatch(new RegExp(`^${url}\\?sig=\\d+\\.[\\w-]+$`));
      }
      const link = openLink((yield* visit(undefined)).body);
      const proof = link.slice(link.indexOf("?"));
      const [exp = "", signature = ""] = proof.slice("?sig=".length).split(".");

      expect(frameSrc((yield* visit(undefined, link)).body)).toContain("/api/assets/host-files/");
      expect(frameSrc((yield* visit("cross-site", link)).body)).toContain(
        "/api/assets/host-files/",
      );
      openLink((yield* visit(undefined, server.url(`home/reports/other.html${proof}`))).body);
      openLink((yield* visit(undefined, `${url}?sig=${Number(exp) + 1}.${signature}`)).body);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("app and asset routes still answer, and a missing file under a root does not", () =>
    Effect.gen(function* () {
      const server = yield* serve({});
      const app = yield* server.get("/settings/general");
      const asset = yield* server.get("/api/assets/not-a-token/x.png");
      const missing = yield* server.get(server.url("home/missing.txt"), READER);

      expect(app.response.status).toBe(200);
      expect(text(app.body)).toBe("<html>app</html>");
      expect(asset.response.status).toBe(404);
      expect(text(asset.body)).toBe("Not Found");
      expect(asset.response.headers.get("cache-control")).toBeNull();
      expect(missing.response.status).toBe(404);
      expect(text(missing.body)).not.toContain("app");
    }).pipe(Effect.provide(layerTest)),
  );
});
