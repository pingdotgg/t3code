import * as AWS from "@alchemy.run/aws";
import { R2 } from "@alchemy.run/cloudflare";
import * as Fly from "@alchemy.run/fly";
import * as Storage from "@alchemy.run/gcp/Storage";
import * as Hetzner from "@alchemy.run/hetzner";
import * as Neon from "@alchemy.run/neon";
import * as Railway from "@alchemy.run/railway";
import type * as Alchemy from "alchemy";
import * as FileSystem from "effect/FileSystem";

const GCP = { Storage };
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class Files extends Context.Service<
  Files,
  { upload(name: string, body: string): Effect.Effect<void, never, Alchemy.RuntimeContext> }
>()("Files") {}

// #region show
export const FilesR2 = Layer.effect(
  Files,
  Effect.gen(function* () {
    const bucket = yield* R2.ReadWriteBucket(yield* R2.Bucket("Files"));
    return {
      upload: (name, body) =>
        bucket
          .put(name, body) /*hide*/
          .pipe(Effect.asVoid, Effect.orDie) /*end*/,
    };
  }),
).pipe(Layer.provide(R2.ReadWriteBucketBinding));

export const FilesS3 = Layer.effect(
  Files,
  Effect.gen(function* () {
    const putObject = yield* AWS.S3.PutObject(yield* AWS.S3.Bucket("Files"));
    return {
      upload: (name, body) =>
        putObject({ Key: name, Body: body }) /*hide*/
          .pipe(Effect.asVoid, Effect.orDie) /*end*/,
    };
  }),
).pipe(Layer.provide(AWS.S3.PutObjectHttp));

export const FilesGCS = Layer.effect(
  Files,
  Effect.gen(function* () {
    const bucket = yield* GCP.Storage.WriteBucket(yield* GCP.Storage.Bucket("Files", {}));
    return {
      upload: (name, body) =>
        bucket
          .put(name, body) /*hide*/
          .pipe(Effect.asVoid, Effect.orDie) /*end*/,
    };
  }),
).pipe(Layer.provide(GCP.Storage.WriteBucketHttp));
// #endregion show

// More stores, for the host roll (not on the Files slide).
export const FilesTigris = Layer.effect(
  Files,
  Effect.gen(function* () {
    const putObject = yield* Fly.PutObject(yield* Fly.Bucket("Files", {}));
    return {
      upload: (name, body) =>
        putObject({ Key: name, Body: body }) /*hide*/
          .pipe(Effect.asVoid, Effect.orDie) /*end*/,
    };
  }),
).pipe(Layer.provide(Fly.PutObjectHttp));

export const FilesRailway = Layer.effect(
  Files,
  Effect.gen(function* () {
    const putObject = yield* Railway.PutObject(
      yield* Railway.Bucket("Files", { project: yield* Railway.Project("Chat", {}) }),
    );
    return {
      upload: (name, body) =>
        putObject({ Key: name, Body: body }) /*hide*/
          .pipe(Effect.asVoid, Effect.orDie) /*end*/,
    };
  }),
).pipe(Layer.provide(Railway.PutObjectHttp));

export const FilesNeon = Layer.effect(
  Files,
  Effect.gen(function* () {
    const bucket = yield* Neon.WriteBucket(
      yield* Neon.Bucket("Files", {
        branch: yield* Neon.Branch("Main", { project: yield* Neon.Project("Db") }),
      }),
    );
    return {
      upload: (name, body) =>
        bucket
          .put(name, body) /*hide*/
          .pipe(Effect.asVoid, Effect.orDie) /*end*/,
    };
  }),
).pipe(Layer.provide(Neon.WriteBucketHttp));

export const FilesVolume = Layer.effect(
  Files,
  Effect.gen(function* () {
    const volume = yield* Hetzner.Volume("Files", { size: 10, format: "ext4", location: "nbg1" });
    const mount = yield* Hetzner.MountVolume(volume, { path: "/files" });
    const fs = yield* FileSystem.FileSystem;
    return {
      upload: (name, body) =>
        fs
          .writeFileString(`${mount.path}/${name}`, body) /*hide*/
          .pipe(Effect.orDie) /*end*/,
    };
  }),
).pipe(Layer.provide(Hetzner.MountVolumeLive));
