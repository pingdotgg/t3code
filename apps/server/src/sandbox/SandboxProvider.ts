import {
  type SandboxProviderInfo,
  SandboxProviderError,
  type SandboxProviderKind,
  type SandboxStage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Schema from "effect/Schema";

export interface SandboxProviderConfig {
  readonly apiKey: string;
}

export interface CreatedSandbox {
  readonly id: string;
  readonly name: string;
  /** A public URL for `port`, when the provider can route it at creation time. */
  readonly publicUrl?: string;
}

export interface SandboxExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxProviderDriver {
  readonly info: Omit<SandboxProviderInfo, "configured">;
  readonly defaultSize: string;
  readonly serverPort: number;
  readonly create: (input: {
    readonly config: SandboxProviderConfig;
    readonly name: string;
    readonly size: string;
    readonly ttlMinutes?: number | undefined;
  }) => Effect.Effect<CreatedSandbox, SandboxProviderError, HttpClient.HttpClient>;
  readonly execute: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
    readonly command: string;
    readonly timeoutSeconds: number;
  }) => Effect.Effect<SandboxExecResult, SandboxProviderError, HttpClient.HttpClient>;
  readonly exposePort: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
    readonly port: number;
  }) => Effect.Effect<string, SandboxProviderError, HttpClient.HttpClient>;
  readonly destroy: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
  }) => Effect.Effect<void, SandboxProviderError, HttpClient.HttpClient>;
}

export const requestJson = Effect.fn("SandboxProvider.requestJson")(function* <
  S extends Schema.Top,
>(input: {
  readonly provider: SandboxProviderKind;
  readonly stage: SandboxStage;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly schema: S;
}): Effect.fn.Return<
  S["Type"],
  SandboxProviderError,
  HttpClient.HttpClient | S["DecodingServices"]
> {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(input.request).pipe(
    Effect.mapError(
      (cause) =>
        new SandboxProviderError({
          provider: input.provider,
          stage: input.stage,
          // The transport message is bounded and does not include the request headers or body.
          detail: "The sandbox provider could not be reached.",
          cause,
        }),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    // Provider bodies can echo request values, so the reason stays structured and the body only
    // ever travels as the cause, never as an attribute or in the message shown to the client.
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* new SandboxProviderError({
      provider: input.provider,
      stage: input.stage,
      status: response.status,
      detail:
        response.status === 401 || response.status === 403
          ? "The provider rejected the API key."
          : response.status === 404
            ? "The provider could not find this resource."
            : `The provider responded with HTTP ${response.status}.`,
      cause: new Error(body.slice(0, 2000)),
    });
  }
  return yield* HttpClientResponse.schemaBodyJson(input.schema)(response).pipe(
    Effect.mapError(
      () =>
        new SandboxProviderError({
          provider: input.provider,
          stage: input.stage,
          detail: "Unexpected response from the sandbox provider.",
        }),
    ),
  );
});

export const authorize = (
  request: HttpClientRequest.HttpClientRequest,
  apiKey: string,
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.setHeaders(request, { authorization: `Bearer ${apiKey}` });

export const jsonBody = (
  request: HttpClientRequest.HttpClientRequest,
  value: unknown,
): HttpClientRequest.HttpClientRequest => HttpClientRequest.bodyJsonUnsafe(request, value);
