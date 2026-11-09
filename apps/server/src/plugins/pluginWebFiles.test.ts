import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  PluginId,
} from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { assetResponseHeaders } from "../http.ts";
import * as PluginHost from "./PluginHost.ts";
import {
  fixturesDir,
  layerConfig,
  layerHost,
  listStates,
  publishedThemeDirectories,
  stateOf,
  waitForStatuses,
  writeFile,
  writePluginsConfig,
} from "./pluginHostTestHarness.ts";

// What the host serves at `/api/plugins/<pluginId><path>`, if anything.
const served = (
  host: PluginHost.PluginHost["Service"],
  pluginId: string,
  path: string,
  revision?: string,
) => host.readWebFile({ pluginId, path, revision }).pipe(Effect.map(Option.getOrUndefined));

const scopesByToken: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer read": [AuthOrchestrationReadScope],
  "Bearer none": [],
};
const layerAuth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  authenticateHttpRequest: (request) => {
    const scopes = scopesByToken[request.headers.authorization ?? ""];
    return scopes === undefined
      ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError())
      : Effect.succeed({
          sessionId: AuthSessionId.make("session"),
          subject: "test",
          method: "bearer-access-token",
          scopes,
        });
  },
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("PluginWebFiles", (it) => {
  it.effect("signs in like reads on the rest of /api and answers 404 for what is not served", () =>
    Effect.gen(function* () {
      const layerHostAnswering = Layer.mock(PluginHost.PluginHost)({
        readWebFile: ({ pluginId, path, revision }) =>
          Effect.succeed(
            pluginId === "styles-plugin"
              ? Option.some({ headers: {}, body: new TextEncoder().encode(`${path} ${revision}`) })
              : Option.none(),
          ),
      });
      const services = yield* Layer.build(
        HttpRouter.serve(PluginHost.layerWebFilesRoute, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(
          Layer.provideMerge(layerHostAnswering),
          Layer.provideMerge(layerAuth),
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      );
      const client = Context.get(services, HttpClient.HttpClient);
      const get = Effect.fn(function* (path: string, token?: string) {
        const response = yield* client.execute(
          HttpClientRequest.get(path).pipe(
            token === undefined
              ? (request) => request
              : HttpClientRequest.setHeader("authorization", token),
          ),
        );
        return { status: response.status, body: yield* response.text };
      });

      assert.strictEqual((yield* get("/api/plugins/styles-plugin/styles/base.css")).status, 401);
      assert.strictEqual(
        (yield* get("/api/plugins/styles-plugin/styles/base.css", "Bearer none")).status,
        403,
      );
      assert.deepStrictEqual(
        yield* get("/api/plugins/styles-plugin/styles/base.css?v=r1", "Bearer read"),
        { status: 200, body: "/styles/base.css r1" },
      );
      assert.strictEqual(
        (yield* get("/api/plugins/other-plugin/styles/base.css", "Bearer read")).status,
        404,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("serves an active plugin's web files and themes, and stops when disabled", () =>
    Effect.gen(function* () {
      const helloWeb = PluginId.make("hello-web");
      yield* writePluginsConfig({
        enabled: { [helloWeb]: true },
        devPaths: [`${fixturesDir}hello-web`],
      });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { [helloWeb]: "active" });

        const response = yield* served(host, helloWeb, "/web.js");
        assert.strictEqual(response?.headers["content-type"], "text/javascript; charset=utf-8");
        // The bundle's revision names its contents, so browsers keep that URL's copy for good.
        const webRevision = stateOf(yield* listStates(host), helloWeb)?.webRevision ?? "";
        assert.match(webRevision, /^[0-9a-f]{16}$/);
        const revised = yield* served(host, helloWeb, "/web.js", webRevision);
        assert.strictEqual(
          revised?.headers["cache-control"],
          "private, max-age=31536000, immutable",
        );
        assert.strictEqual(response?.headers["cache-control"], "no-store");
        const themes = `${fixturesDir}hello-web/themes`;
        assert.deepStrictEqual(publishedThemeDirectories.at(-1), [themes]);
        // A reload hands its folder over once more, so its files are read again, without dropping
        // it first: windows would flash T3's colors.
        publishedThemeDirectories.length = 0;
        yield* host.reload(helloWeb);
        assert.deepStrictEqual(publishedThemeDirectories, [[themes]]);
        const asset = yield* served(host, helloWeb, "/assets/hello.txt");
        assert.strictEqual(asset?.headers["content-type"], "text/plain; charset=utf-8");
        // A path out of the assets folder names no asset; it is not the plugin's failure.
        for (const path of ["/assets/..%2Fserver.cjs", "/assets/%E0%A4%A", "/assets/"]) {
          assert.isUndefined(yield* served(host, helloWeb, path));
        }

        yield* host.setEnabled(helloWeb, false);
        assert.isUndefined(yield* served(host, helloWeb, "/web.js"));
        assert.deepStrictEqual(publishedThemeDirectories.at(-1), []);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect.skipIf(!symlinksSupported)("reads no file a link takes out of the plugin", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const rootDir = `${stateDir}/plugins/linking`;
      yield* writeFile(
        `${rootDir}/t3-plugin.json`,
        JSON.stringify({
          id: "linking",
          name: "Linking",
          version: "0.1.0",
          engines: { t3: ">=0.1.0" },
          web: "./web.js",
        }),
      );
      yield* writeFile(`${rootDir}/styles/base.css`, "body {}");
      yield* writeFile(`${stateDir}/outside/secret.css`, "Not the plugin's.");
      yield* writeFile(`${stateDir}/outside/web.js`, "export default {};");
      yield* fs.symlink(`${stateDir}/outside/secret.css`, `${rootDir}/styles/secret.css`);
      yield* fs.symlink(`${stateDir}/outside/web.js`, `${rootDir}/web.js`);
      yield* writePluginsConfig({ enabled: { linking: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const state = stateOf(yield* waitForStatuses(host, { linking: "active" }), "linking");
        assert.deepStrictEqual(
          state?.styles?.map(({ file }) => file),
          ["base.css"],
        );
        assert.isUndefined(state?.webRevision);
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("serves a plugin's SVG under the sandbox policy T3's own SVG assets get", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const rootDir = `${stateDir}/plugins/drawing`;
      yield* writeFile(
        `${rootDir}/t3-plugin.json`,
        JSON.stringify({
          id: "drawing",
          name: "Drawing",
          version: "0.1.0",
          engines: { t3: ">=0.1.0" },
          web: "./web.js",
        }),
      );
      yield* writeFile(`${rootDir}/web.js`, "export default {};");
      yield* writeFile(
        `${rootDir}/assets/icon.svg`,
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      );
      yield* writePluginsConfig({ enabled: { drawing: true } });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { drawing: "active" });
        const icon = yield* served(host, "drawing", "/assets/icon.svg");
        assert.strictEqual(
          icon?.headers["content-security-policy"],
          assetResponseHeaders("icon.svg")["Content-Security-Policy"],
        );
        assert.notProperty(
          (yield* served(host, "drawing", "/web.js"))?.headers,
          "content-security-policy",
        );
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("serves the stylesheets of a plugin with no code while it is active", () =>
    Effect.gen(function* () {
      const stylesPlugin = PluginId.make("styles-plugin");
      yield* writePluginsConfig({
        enabled: { [stylesPlugin]: true },
        devPaths: [`${fixturesDir}styles-plugin`],
      });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        yield* waitForStatuses(host, { [stylesPlugin]: "active" });
        const call = yield* host
          .invoke({ pluginId: stylesPlugin, method: "ping", input: undefined, scopes: [] })
          .pipe(Effect.flip);
        assert.strictEqual(call._tag, "PluginNoServerError");
        // In name order, which is the order clients apply them in.
        const styles = stateOf(yield* listStates(host), stylesPlugin)?.styles ?? [];
        assert.deepStrictEqual(
          styles.map(({ file }) => file),
          ["base.css", "compact.css"],
        );
        const base = () => served(host, stylesPlugin, "/styles/base.css", styles[0]?.revision);
        const response = yield* base();
        assert.strictEqual(response?.headers["content-type"], "text/css; charset=utf-8");
        assert.strictEqual(
          response?.headers["cache-control"],
          "private, max-age=31536000, immutable",
        );
        assert.isUndefined(yield* served(host, stylesPlugin, "/styles/..%2Ft3-plugin.json"));

        yield* host.setEnabled(stylesPlugin, false);
        assert.isUndefined(stateOf(yield* listStates(host), stylesPlugin)?.styles);
        assert.isUndefined(yield* base());
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );
});
