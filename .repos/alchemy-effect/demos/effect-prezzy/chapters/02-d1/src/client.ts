import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ShortyApi } from "./ShortyApi.ts";

export const API_URL = import.meta.env.VITE_API_URL as string;

// A typed client derived from the same `ShortyApi` value the Worker serves.
const makeClient = HttpApiClient.make(ShortyApi, { baseUrl: API_URL });

export const call = <A, E>(f: (client: Effect.Success<typeof makeClient>) => Effect.Effect<A, E>) =>
  Effect.runPromise(makeClient.pipe(Effect.flatMap(f), Effect.provide(FetchHttpClient.layer)));
