import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "@alchemy.run/test/Bun";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import Stack from "./alchemy.run.ts";
import { ShortyApi } from "./ShortyApi.ts";

// #region show
const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
  // #region dev
  dev: true,
  // #endregion dev
});
// #region deploy

const stack = beforeAll(deploy(Stack));
// #endregion deploy
// #region test

test(
  "creates and reads back a link",
  Effect.gen(function* () {
    const { api } = yield* stack;
    const shorty = yield* HttpApiClient.make(ShortyApi, { baseUrl: api });
    // #region create

    const link = yield* shorty.links.create({ payload: { url: "https://effect.website" } });
    // #endregion create
    // #region check
    const found = yield* shorty.links.get({ params: { code: link.code } });
    expect(found.url).toBe("https://effect.website");
    // #endregion check
  }),
);
// #endregion test
// #endregion show

test(
  "a missing link is a typed LinkNotFound",
  Effect.gen(function* () {
    const { api } = yield* stack;
    const shorty = yield* HttpApiClient.make(ShortyApi, { baseUrl: api });
    const error = yield* shorty.links.get({ params: { code: "nope" } }).pipe(Effect.flip);
    expect(error._tag).toBe("LinkNotFound");
  }),
);

test(
  "lists every link",
  Effect.gen(function* () {
    const { api } = yield* stack;
    const response = yield* Test.executeWhenReady(HttpClientRequest.get(`${api}/links`)).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    );
    expect(response.status).toBe(200);
  }),
);
