import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as vision from "@distilled.cloud/gcp/vision_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { location, logLevel, currentProject, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const OBJECT_NAME = "vision-product.png";

// 320x320 solid red PNG (small-edge >= 300px for Product Search).
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAIAAABC8jL9AAACr0lEQVR42u3TQQkAAAjAwPUvrR38CQeXYLCmgKckAAMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMBgYMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBiQAAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgwMBgYMDAgIHBwICBAQMDBgYDAwYGDAwGlgAMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAgIHBwICBAQODgQEDAwYGDAwGBgwMGBiQAAwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMGBgMDBgYOBoAZd+h1PZeGNgAAAAAElFTkSuQmCC",
  "base64",
);

const waitUntilGone = (name: string) =>
  vision.getProjectsLocationsProductsReferenceImages({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const uploadObject = (bucketName: string, object: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const creds = yield* credentials;
    const client = yield* HttpClient.HttpClient;
    const url =
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucketName)}/o` +
      `?uploadType=media&name=${encodeURIComponent(object)}`;
    const response = yield* client.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeader(
          "Authorization",
          `Bearer ${Redacted.value(creds.accessToken)}`,
        ),
        HttpClientRequest.bodyUint8Array(bytes, "image/png"),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      return yield* Effect.fail(
        new Error(`object upload failed: ${response.status} ${text}`),
      );
    }
  });

test.provider(
  "getProjectsLocationsProductsReferenceImages on a missing image fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vision.getProjectsLocationsProductsReferenceImages({
          name: `projects/${project}/locations/${location}/products/alchemy-missing/referenceImages/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vision", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a reference image",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Storage.Bucket("VisionImages", {
            location: "US-WEST1",
            forceDestroy: true,
          });
        }),
      );
      yield* uploadObject(bucket.bucketName, OBJECT_NAME, RED_PNG);
      const uri = `gs://${bucket.bucketName}/${OBJECT_NAME}`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.Vision.Product("Shoe", {
            location,
            displayName: "Trail runner",
            productCategory: "apparel-v2",
          });
          const image = yield* GCP.Vision.ProductsReferenceImage("Hero", {
            parent: product.name,
            location,
            uri,
            boundingPolys: [
              {
                vertices: [
                  { x: 0, y: 0 },
                  { x: 320, y: 0 },
                  { x: 320, y: 320 },
                  { x: 0, y: 320 },
                ],
              },
            ],
          });
          return { product, image };
        }),
      );

      expect(created.image.name).toContain("/referenceImages/");
      expect(created.image.parent).toEqual(created.product.name);
      expect(created.image.uri).toEqual(uri);
      expect(created.image.referenceImageId.length).toBeGreaterThan(0);

      const fetched = yield* vision.getProjectsLocationsProductsReferenceImages(
        {
          name: created.image.name,
        },
      );
      expect(fetched.name).toEqual(created.image.name);
      expect(fetched.uri).toEqual(uri);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.image.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vision", "live"], timeout: 90_000 },
);
