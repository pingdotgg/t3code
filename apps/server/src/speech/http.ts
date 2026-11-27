import { SpeechSynthesisError } from "@t3tools/contracts";
import { decodeSpeechPcmRequest } from "@t3tools/shared/speech";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  type EnvironmentSpeechModels,
  type SpeechSynthesisCatalog,
  EnvironmentVoiceBodyLimit,
  requiredScopesForServerSettingsPatch,
  SPEECH_MAX_OPTIONS_BYTES,
  TextGenerationError,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SpeechPostProcessing from "./postProcessing.ts";
import * as CloudSpeech from "./CloudSpeech.ts";
import * as OpenRouterSignIn from "./OpenRouterSignIn.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as LocalSpeechSynthesis from "./LocalSpeechSynthesis.ts";
import * as SpeechAligner from "./SpeechAligner.ts";
import * as SpeechService from "./SpeechService.ts";
import * as SpeechSynthesisStreams from "./synthesisStreams.ts";

const MAX_TRANSCRIBE_BODY_BYTES = SpeechService.MAX_SPEECH_BYTES + SPEECH_MAX_OPTIONS_BYTES + 4;
const parseAudio = Option.liftThrowable(decodeSpeechPcmRequest);
const isTextGenerationError = Schema.is(TextGenerationError);

const bodyLimit = Layer.succeed(EnvironmentVoiceBodyLimit, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (Number(request.headers["content-length"]) > MAX_TRANSCRIBE_BODY_BYTES)
      return yield* failEnvironmentInvalidRequest("invalid_audio");
    return yield* effect.pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        ByteSize.bytes(MAX_TRANSCRIBE_BODY_BYTES),
      ),
    );
  }),
);

const mapSpeechError = <A, R>(effect: Effect.Effect<A, SpeechService.SpeechError, R>) =>
  effect.pipe(
    Effect.catchTags({
      SpeechInvalidAudioError: () => failEnvironmentInvalidRequest("invalid_audio"),
      SpeechUnsupportedPlatformError: () => failEnvironmentInvalidRequest("speech_unavailable"),
      SpeechBusyError: () => failEnvironmentInvalidRequest("speech_busy"),
      SpeechDownloadCancelledError: () => failEnvironmentInvalidRequest("speech_busy"),
      SpeechModelNotFoundError: () => failEnvironmentInvalidRequest("invalid_command"),
      SpeechOperationError: (error) => failEnvironmentInternal("internal_error", error),
    }),
  );

// A linked model's origin is a path on this machine; only filesystem readers may see it.
// Untraced: it runs inside each handler's own span.
const withoutHostPaths = Effect.fnUntraced(function* <Fields extends EnvironmentSpeechModels>({
  models,
  ...fields
}: Fields) {
  const session = yield* EnvironmentAuthenticatedPrincipal;
  return {
    ...fields,
    models: session.scopes.has(AuthFilesystemReadScope)
      ? models
      : models.map(({ linkedFrom: _, ...model }) => model),
  };
});

// Untraced: it runs inside each handler's own span.
const withoutCatalogHostPaths = Effect.fnUntraced(function* (catalog: SpeechSynthesisCatalog) {
  const session = yield* EnvironmentAuthenticatedPrincipal;
  if (session.scopes.has(AuthFilesystemReadScope)) return catalog;
  return {
    ...catalog,
    models: catalog.models.map(({ install, ...model }) => {
      if (!install) return model;
      const { linkedFrom: _, ...visible } = install;
      return { ...model, install: visible };
    }),
  };
});

const OPENROUTER_CALLBACK_PATH = "/api/voice/cloud/openrouter/callback";

/** OpenRouter returns only to https, or to this machine over http. */
function isOpenRouterCallback(value: string) {
  try {
    const url = new URL(value);
    return (
      url.pathname === OPENROUTER_CALLBACK_PATH &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost"))
    );
  } catch {
    return false;
  }
}

const SIGN_IN_PAGE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

function signInPage(title: string, detail: string) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>T3 Code</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:360px;padding:32px}h1{font-size:24px}p{line-height:1.6;opacity:.7}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
}

export const speechHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const speech = yield* SpeechService.SpeechService;
    const cloud = yield* CloudSpeech.CloudSpeech;
    const openRouter = yield* OpenRouterSignIn.OpenRouterSignIn;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const local = yield* LocalSpeechSynthesis.LocalSpeechSynthesis;
    const synthesisStreams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
    const aligner = yield* SpeechAligner.SpeechAligner;
    const mapInstallError = <A, R>(
      effect: Effect.Effect<A, LocalSpeechSynthesis.LocalSynthesisInstallError, R>,
    ) =>
      effect.pipe(
        Effect.catchTags({
          // Untraced: it runs inside each handler's own span.
          LocalSynthesisInstallError: Effect.fnUntraced(function* (error) {
            if (error.reason === "failed")
              return yield* failEnvironmentInternal("internal_error", error);
            return yield* failEnvironmentInvalidRequest(
              error.reason === "unknown-model" || error.reason === "not-found"
                ? "invalid_command"
                : error.reason === "busy"
                  ? "speech_busy"
                  : "speech_unavailable",
            );
          }),
        }),
      );
    const postProcessing = yield* SpeechPostProcessing.SpeechPostProcessing;
    const guard = Effect.fnUntraced(function* (
      endpoint: string,
      scope: AuthEnvironmentScope = AuthOrchestrationOperateScope,
    ) {
      yield* annotateEnvironmentRequest(endpoint);
      yield* requireEnvironmentScope(scope);
    });
    return handlers
      .handle(
        "synthesisModels",
        Effect.fn("environment.voice.synthesisModels")(function* (args) {
          yield* guard(args.endpoint.name);
          const catalog =
            args.params.provider === "local"
              ? yield* local.catalog.pipe(Effect.flatMap(withoutCatalogHostPaths))
              : yield* cloud.synthesisModels(args.params.provider).pipe(
                  Effect.catchTags({
                    SpeechSynthesisError: (error) =>
                      Effect.fail(
                        new SpeechSynthesisError({
                          provider: error.provider,
                          reason: error.reason,
                        }),
                      ),
                    ServerSettingsError: (error) =>
                      failEnvironmentInternal("internal_error", error),
                  }),
                );
          // Choosing a provider without word timings fetches the model that times them.
          if (catalog.wordTimings !== "provider") yield* aligner.prepare;
          return catalog;
        }),
      )
      .handle(
        "startSynthesis",
        Effect.fn("environment.voice.startSynthesis")(function* (args) {
          yield* guard(args.endpoint.name);
          const token = yield* synthesisStreams.start(args.params.provider, args.payload).pipe(
            Effect.catchTags({
              SpeechSynthesisError: (error) =>
                Effect.fail(
                  new SpeechSynthesisError({ provider: error.provider, reason: error.reason }),
                ),
              ServerSettingsError: (error) => failEnvironmentInternal("internal_error", error),
            }),
          );
          return { token };
        }),
      )
      .handle(
        "synthesisTimings",
        Effect.fn("environment.voice.synthesisTimings")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* synthesisStreams.timings(args.payload.token, args.payload.after);
        }),
      )
      .handle(
        "prepareSynthesisModel",
        Effect.fn("environment.voice.prepareSynthesisModel")(function* (args) {
          yield* guard(args.endpoint.name);
          yield* local.prepare(args.payload.model);
        }),
      )
      .handle(
        "downloadSynthesisModel",
        Effect.fn("environment.voice.downloadSynthesisModel")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* local
            .download(args.payload.modelId)
            .pipe(mapInstallError, Effect.flatMap(withoutCatalogHostPaths));
        }),
      )
      .handle(
        "cancelSynthesisModel",
        Effect.fn("environment.voice.cancelSynthesisModel")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* local
            .cancel(args.payload.modelId)
            .pipe(Effect.flatMap(withoutCatalogHostPaths));
        }),
      )
      .handle(
        "removeSynthesisModel",
        Effect.fn("environment.voice.removeSynthesisModel")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* local
            .remove(args.payload.modelId)
            .pipe(mapInstallError, Effect.flatMap(withoutCatalogHostPaths));
        }),
      )
      .handle(
        "linkSynthesisModels",
        Effect.fn("environment.voice.linkSynthesisModels")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          // The request names a path on this machine and the result reveals what is there.
          yield* requireEnvironmentScope(AuthFilesystemReadScope);
          return yield* local.link(args.payload.path).pipe(mapInstallError);
        }),
      )
      .handle(
        "cloudKeys",
        Effect.fn("environment.voice.cloudKeys")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* cloud.configured.pipe(
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
        }),
      )
      .handle(
        "setCloudKey",
        Effect.fn("environment.voice.setCloudKey")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          // The key is a setting, so saving it needs what the same settings patch would.
          const { key } = args.payload;
          const value = key === null || Redacted.isRedacted(key) ? "" : key;
          for (const scope of requiredScopesForServerSettingsPatch({
            cloudSpeechCredentials: { [args.params.provider]: value },
          })) {
            yield* requireEnvironmentScope(scope);
          }
          yield* cloud
            .setKey(args.params.provider, args.payload.key)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }),
      )
      .handle(
        "startOpenRouterSignIn",
        Effect.fn("environment.voice.startOpenRouterSignIn")(function* (args) {
          // Signing in saves a key, so it needs what saving one does.
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          for (const scope of requiredScopesForServerSettingsPatch({
            cloudSpeechCredentials: { openrouter: "key" },
          }))
            yield* requireEnvironmentScope(scope);
          const { callbackUrl } = args.payload;
          if (callbackUrl !== null && !isOpenRouterCallback(callbackUrl))
            return yield* failEnvironmentInvalidRequest("invalid_command");
          const { label } = yield* environment.getDescriptor;
          return yield* openRouter.start({ callbackUrl, label: `T3 Code (${label})` });
        }),
      )
      .handle(
        "finishOpenRouterSignIn",
        Effect.fn("environment.voice.finishOpenRouterSignIn")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          yield* openRouter.finish(args.payload.state, args.payload.code);
        }),
      )
      .handle(
        "openRouterSignInStatus",
        Effect.fn("environment.voice.openRouterSignInStatus")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return { status: yield* openRouter.status(args.payload.state) };
        }),
      )
      .handleRaw(
        "openRouterCallback",
        Effect.fn("environment.voice.openRouterCallback")(function* ({ request }) {
          const url = new URL(request.url, "http://localhost");
          const state = url.searchParams.get("state");
          const code = url.searchParams.get("code");
          const outcome =
            state && code ? yield* openRouter.finish(state, code).pipe(Effect.result) : undefined;
          const signedIn = outcome?._tag === "Success";
          return HttpServerResponse.text(
            signInPage(
              signedIn ? "Signed in to OpenRouter" : "OpenRouter sign-in didn’t finish",
              signedIn
                ? "Return to T3 Code. You can close this tab."
                : outcome?._tag === "Failure"
                  ? outcome.failure.message
                  : "OpenRouter didn’t send a sign-in. Return to T3 Code and sign in again.",
            ),
            {
              status: signedIn ? 200 : 400,
              contentType: "text/html; charset=utf-8",
              headers: SIGN_IN_PAGE_HEADERS,
            },
          );
        }),
      )
      .handle(
        "cloudModels",
        Effect.fn("environment.voice.cloudModels")(function* (args) {
          yield* guard(args.endpoint.name);
          return { models: yield* cloud.models };
        }),
      )
      .handle(
        "transcribeCloud",
        Effect.fn("environment.voice.transcribeCloud")(function* (args) {
          yield* guard(args.endpoint.name);
          const decoded = parseAudio(args.payload);
          if (Option.isNone(decoded)) return yield* failEnvironmentInvalidRequest("invalid_audio");
          const text = yield* cloud
            .transcribe(
              args.params.provider,
              decoded.value.pcm,
              decoded.value.options,
              args.query.model,
            )
            .pipe(
              Effect.catchTags({
                ServerSettingsError: (error) => failEnvironmentInternal("internal_error", error),
                SpeechInvalidAudioError: () => failEnvironmentInvalidRequest("invalid_audio"),
              }),
            );
          return { text };
        }),
      )
      .handle(
        "status",
        Effect.fn("environment.voice.status")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* speech.status.pipe(mapSpeechError);
        }),
      )
      .handle(
        "prepareModel",
        Effect.fn("environment.voice.prepareModel")(function* (args) {
          yield* guard(args.endpoint.name);
          yield* speech.prepareModel.pipe(mapSpeechError);
        }),
      )
      .handle(
        "models",
        Effect.fn("environment.voice.models")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* speech
            .models(args.query.benchmarks === "1")
            .pipe(mapSpeechError, Effect.flatMap(withoutHostPaths));
        }),
      )
      .handle(
        "downloadModel",
        Effect.fn("environment.voice.downloadModel")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech
            .downloadModel(args.payload.modelId)
            .pipe(mapSpeechError, Effect.flatMap(withoutHostPaths));
        }),
      )
      .handle(
        "selectModel",
        Effect.fn("environment.voice.selectModel")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech
            .selectModel(args.payload.modelId)
            .pipe(mapSpeechError, Effect.flatMap(withoutHostPaths));
        }),
      )
      .handle(
        "cancelModelDownload",
        Effect.fn("environment.voice.cancelModelDownload")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech
            .cancelDownload(args.payload.modelId)
            .pipe(mapSpeechError, Effect.flatMap(withoutHostPaths));
        }),
      )
      .handle(
        "removeModel",
        Effect.fn("environment.voice.removeModel")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech
            .removeModel(args.payload.modelId)
            .pipe(mapSpeechError, Effect.flatMap(withoutHostPaths));
        }),
      )
      .handle(
        "linkModels",
        Effect.fn("environment.voice.linkModels")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          // The request names a path on this machine and the result reveals what is there.
          yield* requireEnvironmentScope(AuthFilesystemReadScope);
          return yield* speech.linkModels(args.payload.path).pipe(mapSpeechError);
        }),
      )
      .handle(
        "updateAcceleration",
        Effect.fn("environment.voice.updateAcceleration")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.updateAcceleration(args.payload.acceleration).pipe(mapSpeechError);
        }),
      )
      .handle(
        "updateModelUnloadTimeout",
        Effect.fn("environment.voice.updateModelUnloadTimeout")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.updateModelUnloadTimeout(args.payload.timeout).pipe(mapSpeechError);
        }),
      )
      .handle(
        "transcribe",
        Effect.fn("environment.voice.transcribe")(function* (args) {
          yield* guard(args.endpoint.name);
          const decoded = parseAudio(args.payload);
          if (Option.isNone(decoded)) return yield* failEnvironmentInvalidRequest("invalid_audio");
          const text = yield* speech
            .transcribe(decoded.value.pcm, decoded.value.options)
            .pipe(mapSpeechError);
          return { text };
        }),
      )
      .handle(
        "postProcess",
        Effect.fn("environment.voice.postProcess")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* postProcessing
            .process(args.payload)
            .pipe(
              Effect.catch((error) =>
                failEnvironmentInternal(
                  "internal_error",
                  error,
                  isTextGenerationError(error.cause) ? error.cause.detail : undefined,
                ),
              ),
            );
        }),
      );
  }),
).pipe(Layer.provide(bodyLimit), Layer.provide(SpeechPostProcessing.layer));
