import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ShortyApi } from "./ShortyApi.ts";

declare const API_URL: string;

// #region show
const shorty = HttpApiClient.make(ShortyApi, { baseUrl: API_URL });

export const createLink = (url: string) =>
  shorty.pipe(
    Effect.flatMap((client) => client.links.create({ payload: { url } })),
    Effect.provide(FetchHttpClient.layer),
    Effect.runPromise,
  );
// #endregion show
