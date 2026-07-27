import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { ValidationException } from "@distilled.cloud/aws/Errors";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { sha256 } from "../../Util/sha256.ts";
import { Assets } from "../Assets.ts";
import {
  buildMicrovmDockerfile,
  bundleMicrovmProgram,
  DEFAULT_MICROVM_PORT,
  readContextDirectory,
  zipFiles,
} from "./MicrovmBundle.ts";
import { MicrovmImage, type MicrovmImageProps } from "./MicrovmImage.ts";

// Fold the `env` map (user-provided + capability-binding contributions) into the
// MicroVM API's `environmentVariables` (a `Record<string, string>`). Redacted
// values are unwrapped; non-string values are JSON-encoded.
const foldEnv = (
  env: Record<string, any> | undefined,
): Record<string, string> | undefined => {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const v = Redacted.isRedacted(value) ? Redacted.value(value) : value;
    out[key] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const READY_STATES = new Set<string>(["CREATED", "UPDATED"]);
const FAILED_STATES = new Set<string>([
  "CREATE_FAILED",
  "UPDATE_FAILED",
  "DELETE_FAILED",
]);

const toIso = (value: Date | string | undefined): string | undefined =>
  value instanceof Date ? value.toISOString() : value;

// Resolve `buildRole` / `baseImage` (each a string ARN or a materialized
// resource reference) to a plain ARN string. The engine materializes a
// whole-resource prop into its stable attributes (see Plan.ts `resolveInput`),
// so the instance's `.roleArn` / `.imageArn` is a plain string at reconcile.
const resolveBuildRoleArn = (news: MicrovmImageProps): string | undefined =>
  news.buildRole === undefined
    ? undefined
    : typeof news.buildRole === "string"
      ? news.buildRole
      : (news.buildRole.roleArn as unknown as string);

const resolveBaseImageArn = (news: MicrovmImageProps): string | undefined =>
  news.baseImage === undefined
    ? undefined
    : typeof news.baseImage === "string"
      ? news.baseImage
      : (news.baseImage.imageArn as unknown as string);

// Properties (besides the artifact content) that affect the built image.
const buildPropsIdentity = (news: MicrovmImageProps) =>
  JSON.stringify({
    baseImageArn: resolveBaseImageArn(news) ?? null,
    baseImageVersion: news.baseImageVersion ?? null,
    description: news.description ?? null,
    logging: news.logging ?? null,
    egressNetworkConnectors: [...(news.egressNetworkConnectors ?? [])].sort(),
    cpuConfigurations: news.cpuConfigurations ?? [],
    resources: news.resources ?? [],
    additionalOsCapabilities: [...(news.additionalOsCapabilities ?? [])].sort(),
    hooks: news.hooks ?? null,
    env: news.env ?? {},
  });

interface ResolvedArtifact {
  uri: string;
  hash: string;
}

const resolveName = (id: string, name?: string) =>
  name
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: 64, delimiter: "-" });

// `getMicrovmImage` requires an ARN or ID — it rejects a plain name with a
// `ValidationException` ("Invalid ARN format"). Only call it with an
// ARN/ID.
const getImage = (identifier: string) =>
  microvms
    .getMicrovmImage({ imageIdentifier: identifier })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

// Look an image up by its (name-only) identifier via the name filter, since
// `getMicrovmImage` won't accept a name. Returns the full image or undefined.
const findImageByName = Effect.fn(function* (name: string) {
  const summaries = yield* microvms.listMicrovmImages
    .items({ nameFilter: name })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );
  const match = summaries.find((summary) => summary.name === name);
  return match ? yield* getImage(match.imageArn) : undefined;
});

const defaultBaseImageArn = Effect.fn(function* () {
  const items = yield* microvms.listManagedMicrovmImages.items({}).pipe(
    Stream.runCollect,
    Effect.map((c) => Array.from(c)),
  );
  const base = items.find((i) => i.imageArn.includes("al2023")) ?? items[0];
  if (!base) {
    return yield* Effect.die(
      "No managed MicroVM base images available; set `baseImage`.",
    );
  }
  return base.imageArn;
});

// Materialize + upload the code artifact and compute its build identity hash.
const resolveArtifact = Effect.fn(function* (
  news: MicrovmImageProps,
  session: ScopedPlanStatusSession,
) {
  const propsId = buildPropsIdentity(news);

  if (news.main) {
    const runtime = news.runtime ?? "node";
    const port = news.port ?? DEFAULT_MICROVM_PORT;
    yield* session.note("Bundling MicroVM program...");
    const { files, hash: bundleHash } = yield* bundleMicrovmProgram({
      main: news.main,
      runtime,
      isExternal: news.isExternal ?? false,
      external: news.external,
      port,
    });
    const dockerfile = buildMicrovmDockerfile(news.dockerfile, runtime, port);
    const hash = yield* sha256(`${bundleHash}:${dockerfile}:${propsId}`);
    const archive = yield* zipFiles([
      { path: "Dockerfile", content: dockerfile },
      ...files,
    ]);
    const assets = yield* Assets;
    const key = yield* assets.uploadAsset(hash, archive);
    const bucket = yield* assets.bucketName;
    return { uri: `s3://${bucket}/${key}`, hash };
  }

  if (news.context) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    yield* session.note("Packaging MicroVM build context...");
    const files = yield* readContextDirectory(news.context);
    // Ensure a Dockerfile is present (resolve from `dockerfile` path or default).
    const dockerfileName = news.dockerfile ?? "Dockerfile";
    const hasDockerfile = files.some((f) => f.path === dockerfileName);
    if (!hasDockerfile) {
      const dockerfilePath = path.join(news.context, dockerfileName);
      const content = yield* fs
        .readFile(dockerfilePath)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (content) files.push({ path: "Dockerfile", content });
    }
    const contentId = files
      .map((f) => `${f.path}:${f.content.byteLength}`)
      .sort()
      .join("|");
    const hash = yield* sha256(`${contentId}:${propsId}`);
    const archive = yield* zipFiles(files);
    const assets = yield* Assets;
    const key = yield* assets.uploadAsset(hash, archive);
    const bucket = yield* assets.bucketName;
    return { uri: `s3://${bucket}/${key}`, hash };
  }

  if (news.codeArtifact?.uri) {
    const hash = yield* sha256(`${news.codeArtifact.uri}:${propsId}`);
    return { uri: news.codeArtifact.uri, hash };
  }

  return yield* Effect.die(
    "MicrovmImage requires one of `main`, `context`, or `codeArtifact.uri`.",
  );
});

const toAttrs = (
  image: microvms.GetMicrovmImageOutput,
  artifact?: ResolvedArtifact,
): MicrovmImage["Attributes"] => ({
  imageArn: image.imageArn,
  name: image.name,
  state: image.state,
  imageVersion:
    image.latestActiveImageVersion ?? image.latestFailedImageVersion,
  latestActiveImageVersion: image.latestActiveImageVersion,
  latestFailedImageVersion: image.latestFailedImageVersion,
  createdAt: toIso(image.createdAt),
  updatedAt: toIso(image.updatedAt),
  codeArtifact: artifact
    ? { uri: artifact.uri, hash: artifact.hash }
    : undefined,
});

const requireBuildRole = (news: MicrovmImageProps) => {
  const arn = resolveBuildRoleArn(news);
  return arn
    ? Effect.succeed(arn)
    : Effect.die("MicrovmImage requires `buildRole` to build the image.");
};

const createImage = Effect.fn(function* (
  name: string,
  news: MicrovmImageProps,
  artifact: ResolvedArtifact,
  baseImageArn: string,
  desiredTags: Record<string, string>,
  session: ScopedPlanStatusSession,
) {
  const buildRoleArn = yield* requireBuildRole(news);
  yield* session.note(`Creating MicroVM image ${name}...`);
  const created = yield* microvms
    .createMicrovmImage({
      name,
      baseImageArn,
      baseImageVersion: news.baseImageVersion,
      buildRoleArn,
      codeArtifact: { uri: artifact.uri },
      description: news.description,
      logging: news.logging,
      egressNetworkConnectors: news.egressNetworkConnectors,
      cpuConfigurations: news.cpuConfigurations,
      resources: news.resources,
      additionalOsCapabilities: news.additionalOsCapabilities,
      hooks: news.hooks,
      environmentVariables: foldEnv(news.env),
      tags: desiredTags,
    })
    .pipe(
      Effect.catchTag("ConflictException", () =>
        getImage(name).pipe(
          Effect.flatMap((existing) =>
            existing
              ? Effect.succeed({ imageArn: existing.imageArn })
              : Effect.die(
                  `MicroVM image ${name} conflicted but was not found.`,
                ),
          ),
        ),
      ),
    );
  return yield* waitForReady(created.imageArn, session);
});

const updateImage = Effect.fn(function* (
  imageArn: string,
  news: MicrovmImageProps,
  artifact: ResolvedArtifact,
  baseImageArn: string,
  session: ScopedPlanStatusSession,
) {
  const buildRoleArn = yield* requireBuildRole(news);
  yield* session.note(`Updating MicroVM image ${news.name ?? imageArn}...`);
  const updated = yield* microvms.updateMicrovmImage({
    imageIdentifier: imageArn,
    baseImageArn,
    baseImageVersion: news.baseImageVersion,
    buildRoleArn,
    codeArtifact: { uri: artifact.uri },
    description: news.description,
    logging: news.logging,
    egressNetworkConnectors: news.egressNetworkConnectors,
    cpuConfigurations: news.cpuConfigurations,
    resources: news.resources,
    additionalOsCapabilities: news.additionalOsCapabilities,
    hooks: news.hooks,
    environmentVariables: foldEnv(news.env),
  });
  return yield* waitForReady(updated.imageArn, session);
});

const syncTags = Effect.fn(function* (
  imageArn: string,
  observedTags: Record<string, string>,
  desiredTags: Record<string, string>,
) {
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (removed.length > 0) {
    yield* microvms.untagResource({ Resource: imageArn, TagKeys: removed });
  }
  if (upsert.length > 0) {
    yield* microvms.tagResource({
      Resource: imageArn,
      Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
});

export const MicrovmImageProvider = () =>
  Provider.succeed(MicrovmImage, {
    stables: ["imageArn", "name"],

    diff: Effect.fn(function* ({ id, olds, news }) {
      if (!isResolved(news)) return;
      const oldName = yield* resolveName(id, olds.name);
      const newName = yield* resolveName(id, news.name);
      if (oldName !== newName) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      // Prefer the cached ARN; otherwise look up by name (getMicrovmImage
      // rejects names).
      const image = output?.imageArn
        ? yield* getImage(output.imageArn)
        : yield* findImageByName(
            output?.name ?? (yield* resolveName(id, olds?.name)),
          );
      return image
        ? toAttrs(image, output?.codeArtifact as ResolvedArtifact | undefined)
        : undefined;
    }),

    list: () =>
      Effect.gen(function* () {
        const summaries = yield* microvms.listMicrovmImages.items({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
        const images = yield* Effect.forEach(
          summaries,
          (summary) => getImage(summary.imageArn),
          { concurrency: 10 },
        );
        return images.flatMap((image) => (image ? [toAttrs(image)] : []));
      }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = yield* resolveName(id, news.name);
      const internalTags = yield* createInternalTags(id);
      const desiredTags = { ...internalTags, ...news.tags };
      const baseImageArn =
        resolveBaseImageArn(news) ?? (yield* defaultBaseImageArn());

      // Resolve + upload the artifact and compute its build identity.
      const artifact = yield* resolveArtifact(news, session);

      // Observe — prefer the cached ARN; otherwise look up by name (a name
      // is not a valid `getMicrovmImage` identifier).
      const observed = output?.imageArn
        ? yield* getImage(output.imageArn)
        : yield* findImageByName(name);

      // Ensure + sync: rebuild only when the build identity changed.
      const image = !observed
        ? yield* createImage(
            name,
            news,
            artifact,
            baseImageArn,
            desiredTags,
            session,
          )
        : output?.codeArtifact?.hash === artifact.hash
          ? observed
          : yield* updateImage(
              observed.imageArn,
              news,
              artifact,
              baseImageArn,
              session,
            );

      yield* syncTags(
        image.imageArn,
        (image.tags ?? {}) as Record<string, string>,
        desiredTags,
      );

      yield* session.note(`MicroVM image ${name} is ${image.state}`);
      return toAttrs(image, artifact);
    }),

    delete: Effect.fn(function* ({ output, session }) {
      // An image can't be deleted while it still has MicroVMs running — tear
      // them down first and wait for them to disappear.
      yield* terminateRunningMicrovms(output.imageArn, session);
      yield* session.note(`Deleting MicroVM image ${output.name}...`);

      yield* microvms
        .deleteMicrovmImage({ imageIdentifier: output.imageArn })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          // A MicroVM caught mid-termination still blocks the delete; retry
          // briefly until the instances are fully gone.
          Effect.retry({
            while: (e): e is ValidationException =>
              e._tag === "ValidationException" &&
              e.message.includes("running MicroVMs"),
            schedule: Schedule.max([
              Schedule.fixed(5_000),
              Schedule.recurs(12),
            ]),
          }),
        );
      yield* waitForDeleted(output.imageArn, session);
    }),
  });

class ImageBuilding extends Data.TaggedError("ImageBuilding")<{
  imageArn: string;
  state: string;
}> {}

class ImageFailed extends Data.TaggedError("ImageFailed")<{
  imageArn: string;
  state: string;
  reason?: string;
}> {}

class MicrovmsActive extends Data.TaggedError("MicrovmsActive")<{
  count: number;
}> {}

// MicroVM states that still hold a slot on the image and block its deletion.
const ACTIVE_MICROVM_STATES = new Set<string>([
  "PENDING",
  "RUNNING",
  "SUSPENDING",
  "SUSPENDED",
]);

const listActiveMicrovms = (imageArn: string) =>
  microvms.listMicrovms.items({ imageIdentifier: imageArn }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).filter((m) => ACTIVE_MICROVM_STATES.has(m.state)),
    ),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed([] as microvms.MicrovmItem[]),
    ),
  );

// Terminate every running MicroVM launched from this image and wait until none
// remain active — a prerequisite for deleting the image.
const terminateRunningMicrovms = Effect.fn(function* (
  imageArn: string,
  session: ScopedPlanStatusSession,
) {
  const active = yield* listActiveMicrovms(imageArn);
  if (active.length === 0) return;
  yield* session.note(`Terminating ${active.length} running MicroVM(s)...`);
  yield* Effect.forEach(
    active,
    (m) =>
      microvms.terminateMicrovm({ microvmIdentifier: m.microvmId }).pipe(
        // Already gone or mid-transition — the wait below converges anyway.
        Effect.catchTag(
          [
            "ResourceNotFoundException",
            "ConflictException",
            "ValidationException",
          ],
          () => Effect.void,
        ),
      ),
    { concurrency: 5, discard: true },
  );
  yield* listActiveMicrovms(imageArn).pipe(
    Effect.flatMap((remaining) =>
      remaining.length === 0
        ? Effect.void
        : new MicrovmsActive({ count: remaining.length }),
    ),
    Effect.retry({
      while: (e) => e._tag === "MicrovmsActive",
      schedule: Schedule.max([Schedule.fixed(5_000), Schedule.recurs(24)]).pipe(
        Schedule.tap(() =>
          session.note("Waiting for MicroVMs to terminate..."),
        ),
      ),
    }),
  );
});

// Drill into the failed version's `stateReason` (and per-architecture build
// state reasons) so a build failure surfaces an actionable message instead of
// just `CREATE_FAILED`.
const buildFailureReason = Effect.fn(function* (
  imageArn: string,
  imageVersion: string | undefined,
) {
  if (!imageVersion) return undefined;
  const version = yield* microvms
    .getMicrovmImageVersion({ imageIdentifier: imageArn, imageVersion })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  // A version fans out to one build per architecture/chipset; report the reason
  // from each build that actually FAILED (keyed by architecture so multi-platform
  // failures are distinguishable). `buildState` is the reliable signal — don't
  // guess via timestamps.
  const builds = yield* microvms.listMicrovmImageBuilds
    .items({ imageIdentifier: imageArn, imageVersion })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catch(() =>
        Effect.succeed([] as microvms.MicrovmImageBuildSummary[]),
      ),
    );
  const failedBuildReasons = builds
    .filter((b) => b.buildState === "FAILED" && b.stateReason)
    .map((b) => `${b.architecture}: ${b.stateReason}`);
  // Prefer the per-build failure reasons; fall back to the version-level reason.
  const reasons =
    failedBuildReasons.length > 0
      ? [...new Set(failedBuildReasons)]
      : [version?.stateReason].filter((r): r is string => !!r);
  return reasons.join("; ");
});

const waitForReady = (imageArn: string, session: ScopedPlanStatusSession) =>
  Effect.gen(function* () {
    const image = yield* microvms.getMicrovmImage({
      imageIdentifier: imageArn,
    });
    if (READY_STATES.has(image.state)) return image;
    if (FAILED_STATES.has(image.state)) {
      const reason = yield* buildFailureReason(
        imageArn,
        image.latestFailedImageVersion,
      );
      yield* session.note(
        `MicroVM image build ${image.state}: ${reason ?? "(no reason reported)"}`,
      );
      yield* Effect.logError(
        `MicroVM image ${imageArn} build ${image.state}: ${reason ?? "(no reason reported)"}`,
      );
      return yield* new ImageFailed({ imageArn, state: image.state, reason });
    }
    return yield* new ImageBuilding({ imageArn, state: image.state });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ImageBuilding",
      schedule: Schedule.max([
        Schedule.fixed(10_000),
        Schedule.recurs(72),
      ]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(`Waiting for MicroVM image build... (${attempt * 10}s)`),
        ),
      ),
    }),
  );

const waitForDeleted = (imageArn: string, session: ScopedPlanStatusSession) =>
  Effect.gen(function* () {
    const image = yield* microvms
      .getMicrovmImage({ imageIdentifier: imageArn })
      .pipe(
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      );
    if (!image || image.state === "DELETED") return;
    if (image.state === "DELETE_FAILED") {
      return yield* new ImageFailed({ imageArn, state: image.state });
    }
    return yield* new ImageBuilding({ imageArn, state: image.state });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ImageBuilding",
      schedule: Schedule.max([
        Schedule.fixed(10_000),
        Schedule.recurs(72),
      ]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(
            `Waiting for MicroVM image deletion... (${attempt * 10}s)`,
          ),
        ),
      ),
    }),
  );
