import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ConnectHttp from "./http.ts";

class ConnectTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.connect) {}

// The signed relay routes need no session, so a CloudLink that fails each
// request shows how the transport answers that failure.
type HealthFailure = Effect.Error<
  ReturnType<CloudLink.CloudLink["Service"]["answerHealthRequest"]>
>;

const answerHealthWith = async (failure: HealthFailure) => {
  const layerRoutes = HttpApiBuilder.layer(ConnectTestApi).pipe(
    Layer.provide(ConnectHttp.layer),
    Layer.provide(
      Layer.mock(CloudLink.CloudLink)({
        answerHealthRequest: () => Effect.fail(failure),
      }),
    ),
    // The session-gated routes are declared too; this request never reaches them.
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(Layer.mock(EnvironmentAuth.EnvironmentAuth)({})),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(layerRoutes, {
    disableLogger: true,
  });
  try {
    const response = await handler(
      new Request("http://127.0.0.1/api/t3-connect/health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proof: "proof" }),
      }),
    );
    return { status: response.status, body: (await response.json()) as unknown };
  } finally {
    await dispose();
  }
};

describe("connect routes", () => {
  it.each([
    {
      failure: new CloudLink.CloudLinkProofRejectedError({ request: "health" }),
      status: 401,
      body: { _tag: "EnvironmentHttpUnauthorizedError", message: "Invalid cloud health request." },
    },
    {
      failure: new CloudLink.CloudLinkProofReplayedError({ request: "health" }),
      status: 409,
      body: {
        _tag: "EnvironmentHttpConflictError",
        message: "Cloud health request was already consumed.",
      },
    },
    {
      failure: new CloudLink.CloudLinkInternalError({
        operation: "answer-health",
        cause: new Error("disk full"),
      }),
      status: 500,
      body: {
        _tag: "EnvironmentHttpInternalServerError",
        message: "Could not answer cloud health request.",
      },
    },
    {
      failure: new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({}),
      status: 500,
      body: {
        _tag: "EnvironmentHttpInternalServerError",
        message: "Cloud mint public key is not installed for this environment.",
      },
    },
  ])("answers $failure._tag with HTTP $status", async ({ failure, status, body }) => {
    const response = await answerHealthWith(failure);
    expect(response).toEqual({ status, body });
  });
});
