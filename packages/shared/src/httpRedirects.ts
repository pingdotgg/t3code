import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient } from "effect/http";

const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

export const withManualRedirects = <E, R>(
  client: HttpClient.HttpClient.With<E, R>,
): HttpClient.HttpClient.With<E, R> =>
  HttpClient.transform(client, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, MANUAL_REDIRECT),
  );

export const layerManualRedirects = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, withManualRedirects),
);
