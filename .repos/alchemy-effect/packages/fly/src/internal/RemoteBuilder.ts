import {
  DockerEnvironment,
  type Docker,
  type RegistryCredentials,
} from "@alchemy.run/docker/Docker";
import * as builders from "@distilled.cloud/fly-io/builders";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/**
 * Build images on Fly's remote builders, the way `fly deploy` does: Fly's
 * GraphQL API starts a Depot build for the App, Depot hands back a BuildKit
 * machine next to Fly's registry, and `docker buildx` drives it through the
 * `remote` driver. Only the build context leaves this machine; the base
 * image is pulled and the result pushed from the builder.
 */

const DEPOT_API = "https://api.depot.dev/depot.cli.v1.BuildService";
/**
 * Depot builders push `registry.fly.io` images through Fly's internal registry
 * mirror, which takes the same login (`authConfigs` in flyctl's imgsrc).
 */
const FLY_REGISTRY_MIRROR = "_api.internal:5000";
const HEALTH_INTERVAL = Duration.seconds(5);
/** Builders usually go active within ~15s; give up well before the deploy would. */
const MAX_PENDING_POLLS = 240;
/** How often, and how long, to wait for the builder's push to reach `registry.fly.io`. */
const UPSTREAM_POLL = Duration.seconds(2);
const MAX_UPSTREAM_POLLS = 30;
/** Pushes of one image before giving up on it reaching the registry. */
const MAX_PUSHES = 3;

export class RemoteBuilderError extends Data.TaggedError("Fly.RemoteBuilderError")<{
  operation: string;
  message: string;
}> {}

const BuildKitConnection = Schema.Union([
  Schema.Struct({
    active: Schema.Struct({
      endpoint: Schema.String,
      serverName: Schema.String,
      cert: Schema.Struct({ cert: Schema.String, key: Schema.String }),
      caCert: Schema.Struct({ cert: Schema.String }),
    }),
  }),
  Schema.Struct({ pending: Schema.Struct({ waitMs: Schema.optional(Schema.Number) }) }),
]);

const depot = Effect.fn(function* <A>(
  method: string,
  token: Redacted.Redacted<string>,
  body: unknown,
  response: Schema.Codec<A, unknown>,
) {
  const client = yield* HttpClient.HttpClient;
  const fail = (message: string) => new RemoteBuilderError({ operation: method, message });
  const res = yield* client
    .execute(
      HttpClientRequest.post(`${DEPOT_API}/${method}`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    )
    .pipe(Effect.mapError((cause) => fail(String(cause))));
  if (res.status < 200 || res.status >= 300) {
    const text = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* fail(`HTTP ${res.status}: ${text}`);
  }
  return yield* HttpClientResponse.schemaBodyJson(response)(res).pipe(
    Effect.mapError(() => fail("unexpected response body")),
  );
});

const basicAuth = ({ username, password }: RegistryCredentials) =>
  Base64.encode(
    `${username}:${Redacted.isRedacted(password) ? Redacted.value(password) : password}`,
  );

const platformOf = (platform: string) =>
  /arm|aarch/.test(platform) ? "BUILDER_PLATFORM_ARM64" : "BUILDER_PLATFORM_AMD64";

/** Poll Depot until the build's BuildKit machine is active. */
const acquireConnection = Effect.fn(function* (
  buildId: string,
  token: Redacted.Redacted<string>,
  platform: string,
) {
  for (let poll = 0; poll < MAX_PENDING_POLLS; poll++) {
    const connection = yield* depot(
      "GetBuildKitConnection",
      token,
      { buildId, platform: platformOf(platform) },
      BuildKitConnection,
    );
    if ("active" in connection) return connection.active;
    yield* Effect.sleep(Duration.millis(connection.pending.waitMs ?? 500));
  }
  return yield* new RemoteBuilderError({
    operation: "GetBuildKitConnection",
    message: `builder for build ${buildId} did not become active`,
  });
});

/**
 * Build `imageRef` from `contextDir` on a Fly remote builder and push it to
 * `registry` from there.
 */
export const buildOnRemoteBuilder = Effect.fn(function* (input: {
  docker: Docker["Service"];
  appName: string;
  contextDir: string;
  imageRef: string;
  platform: string;
  registry: RegistryCredentials;
  note?: (message: string) => Effect.Effect<void>;
}) {
  const note = input.note ?? ((_message: string) => Effect.void);
  const { buildId, buildToken } = yield* builders.ensureDepotRemoteBuilder({
    input: { appName: input.appName, builderScope: "app" },
  });
  const token = Redacted.isRedacted(buildToken) ? buildToken : Redacted.make(buildToken);
  const platform = platformOf(input.platform);

  const finish = (result: object) =>
    depot("FinishBuild", token, { buildId, ...result }, Schema.Unknown).pipe(Effect.ignore);

  return yield* Effect.gen(function* () {
    // Depot reclaims a builder that stops reporting health.
    yield* depot("ReportBuildHealth", token, { buildId, platform }, Schema.Unknown).pipe(
      Effect.ignore,
      Effect.repeat(Schedule.spaced(HEALTH_INTERVAL)),
      Effect.forkScoped,
    );
    const connection = yield* acquireConnection(buildId, token, input.platform);

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-fly-builder-" });
    const file = (name: string, content: string) =>
      fs
        .writeFileString(path.join(dir, name), content, { mode: 0o600 })
        .pipe(Effect.as(path.join(dir, name)));
    const cacert = yield* file("ca.pem", connection.caCert.cert);
    const cert = yield* file("cert.pem", connection.cert.cert);
    const key = yield* file("key.pem", connection.cert.key);

    const builder = `alchemy-fly-${buildId}`.replace(/[^a-zA-Z0-9_-]/g, "-");
    yield* Effect.acquireRelease(
      input.docker.run([
        "buildx",
        "create",
        "--name",
        builder,
        "--driver",
        "remote",
        "--driver-opt",
        `cacert=${cacert},cert=${cert},key=${key},servername=${connection.serverName}`,
        connection.endpoint,
      ]),
      () => input.docker.run(["buildx", "rm", builder]).pipe(Effect.ignore),
    );

    // The builder pushes through its host's registry mirror, which forwards
    // to registry.fly.io. Machines pull from there, so confirm the tag landed
    // (usually within seconds) while the builder is still held. The mirror
    // occasionally drops a push without an error, so a tag that hasn't
    // landed is pushed again: the builder has every layer cached, so a
    // repeat build only re-sends the image.
    const build = input.docker.image
      .build(
        {
          context: input.contextDir,
          tag: input.imageRef,
          platform: input.platform,
          // Buildx attaches provenance by default, which pushes an image index.
          // The builder's registry mirror never forwards an index to
          // registry.fly.io, so the image would only exist on the builder.
          // flyctl's BuildKit client adds no attestations either.
          args: ["--provenance=false", "--sbom=false"],
        },
        undefined,
        input.registry,
      )
      .pipe(
        Effect.provideService(DockerEnvironment, {
          BUILDX_BUILDER: builder,
          DOCKER_AUTH_CONFIG: JSON.stringify({
            auths: { [FLY_REGISTRY_MIRROR]: { auth: basicAuth(input.registry) } },
          }),
        }),
      );
    const landed = input.docker
      .run(["buildx", "imagetools", "inspect", "--raw", input.imageRef])
      .pipe(
        Effect.provideService(DockerEnvironment, {
          DOCKER_AUTH_CONFIG: JSON.stringify({
            auths: { [input.registry.server]: { auth: basicAuth(input.registry) } },
          }),
        }),
        Effect.retry({ schedule: Schedule.spaced(UPSTREAM_POLL), times: MAX_UPSTREAM_POLLS }),
        Effect.mapError(
          () =>
            new RemoteBuilderError({
              operation: "upload",
              message: `${input.imageRef} did not reach ${input.registry.server} after ${MAX_PUSHES} pushes`,
            }),
        ),
      );
    const started = yield* Clock.currentTimeMillis;
    yield* build.pipe(
      Effect.andThen(landed),
      Effect.tapError((error) =>
        error._tag === "Fly.RemoteBuilderError" && error.operation === "upload"
          ? note(`${input.imageRef} hasn't reached ${input.registry.server} yet`)
          : Effect.void,
      ),
      Effect.retry({
        while: (error) => error._tag === "Fly.RemoteBuilderError" && error.operation === "upload",
        times: MAX_PUSHES - 1,
      }),
    );
    const waited = (yield* Clock.currentTimeMillis) - started;
    yield* note(`${input.imageRef} available on ${input.registry.server} after ${waited}ms`);
  }).pipe(
    Effect.scoped,
    Effect.tapError((error) => finish({ error: { error: String(error) } })),
    Effect.tap(() => finish({ success: {} })),
    Effect.onInterrupt(() => finish({ canceled: {} })),
  );
});
