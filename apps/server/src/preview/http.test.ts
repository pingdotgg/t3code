import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as PreviewHttp from "./http.ts";
import * as ThreadBrowser from "./ThreadBrowser.ts";

class PreviewTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.preview) {}

it.effect("opens http(s) pages for preview:operate sessions in threads that exist", () =>
  Effect.gen(function* () {
    let scopes: ReadonlyArray<AuthEnvironmentScope> = ["preview:operate"];
    const opened: Array<{ readonly threadId: string; readonly url: string }> = [];
    const routes = HttpApiBuilder.layer(PreviewTestApi).pipe(
      Layer.provide(PreviewHttp.layer),
      Layer.provide(
        Layer.mock(ThreadBrowser.ThreadBrowser)({
          open: (input) =>
            input.threadId === "thread-1"
              ? Effect.sync(() => void opened.push(input))
              : Effect.fail(
                  new ThreadBrowser.ThreadBrowserThreadNotFoundError({ threadId: input.threadId }),
                ),
        }),
      ),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          Effect.suspend(() =>
            effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("cli-session"),
                subject: "cli",
                method: "bearer-access-token",
                scopes: new Set(scopes),
              }),
            ),
          ),
        ),
      ),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const open = (body: { readonly threadId: string; readonly url: string }) =>
      Effect.promise(() =>
        handler(
          new Request("http://localhost/api/preview/open", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        ),
      ).pipe(Effect.map((response) => response.status));

    const url = "https://github.com/login/device?code=AB&next=/";
    for (const rejected of ["file:///etc/passwd", "javascript:alert(1)", "example.com", " "]) {
      expect(yield* open({ threadId: "thread-1", url: rejected }), rejected).toBe(400);
    }
    expect(yield* open({ threadId: "thread-gone", url })).toBe(404);
    expect(yield* open({ threadId: "thread-1", url })).toBe(204);
    expect(opened).toEqual([{ threadId: "thread-1", url }]);

    scopes = ["orchestration:read"];
    expect(yield* open({ threadId: "thread-1", url })).toBe(403);
    expect(opened).toHaveLength(1);
  }).pipe(Effect.scoped),
);
