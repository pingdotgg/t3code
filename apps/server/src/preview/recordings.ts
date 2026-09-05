// @effect-diagnostics nodeBuiltinImport:off - Recording filenames use cryptographically random IDs.
import * as NodeCrypto from "node:crypto";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";

const MAX_RECORDING_BYTES = 64 * 1024 * 1024;

export const previewRecordingRouteLayer = HttpRouter.add(
  "POST",
  "/api/preview/recordings",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request);
    if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
      return HttpServerResponse.empty({ status: 403 });
    }
    const mimeType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (mimeType !== "video/webm" && mimeType !== "video/mp4") {
      return HttpServerResponse.empty({ status: 415 });
    }
    const sizeHeader = request.headers["content-length"];
    const size = sizeHeader === undefined ? undefined : Number(sizeHeader);
    if (
      size !== undefined &&
      (!Number.isSafeInteger(size) || size < 1 || size > MAX_RECORDING_BYTES)
    ) {
      return HttpServerResponse.empty({ status: 413 });
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const directory = path.join(config.stateDir, "browser-artifacts");
    const extension = mimeType === "video/mp4" ? "mp4" : "webm";
    const target = path.join(
      directory,
      `browser-recording-${NodeCrypto.randomUUID()}.${extension}`,
    );
    const temporary = `${target}.part`;
    // Keep ingress alive until the response is sent when rejecting an oversized stream.
    const bodyPull = yield* Stream.toPull(request.stream);
    let received = 0;
    return yield* Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* Stream.run(
        Stream.fromPull(Effect.succeed(bodyPull)).pipe(
          Stream.takeWhile((chunk) => {
            received += chunk.byteLength;
            return received <= MAX_RECORDING_BYTES;
          }),
        ),
        fs.sink(temporary),
      );
      if (received > MAX_RECORDING_BYTES) return HttpServerResponse.empty({ status: 413 });
      if (received === 0 || (size !== undefined && received !== size)) {
        return HttpServerResponse.empty({ status: 400 });
      }
      yield* fs.rename(temporary, target);
      return HttpServerResponse.jsonUnsafe({ path: target });
    }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
  }).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
      Effect.succeed(HttpServerResponse.empty({ status: 401 })),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, () =>
      Effect.succeed(HttpServerResponse.empty({ status: 500 })),
    ),
  ),
);
