import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";

const appPageHeaders = Effect.fn("SameOriginFrameTest.appPageHeaders")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-frame-headers-" });
  yield* fs.writeFileString(path.join(staticDir, "index.html"), "<html></html>");
  const services = yield* Layer.build(
    HttpRouter.serve(
      ServerHttp.layerStaticAndDevRoute.pipe(Layer.provideMerge(NodeHttpPlatform.layer)),
      { disableListenLog: true },
    ).pipe(
      Layer.provideMerge(ServerConfig.layer({ ...config, staticDir })),
      Layer.provideMerge(Layer.succeed(HostProcess.Environment, environment)),
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  );
  const response = yield* Context.get(services, HttpClient.HttpClient).get("/");
  return response.headers;
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-frame-headers-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("frame headers of the app page", (it) => {
  it.effect("the same-origin switch lets only the page's own origin frame the app", () =>
    Effect.gen(function* () {
      const headers = yield* appPageHeaders({ T3CODE_ALLOW_SAME_ORIGIN_FRAME: "1" });

      expect(headers["content-security-policy"]).toBe("frame-ancestors 'self'");
      expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
    }),
  );
});
