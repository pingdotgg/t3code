import * as Hetzner from "@/Hetzner";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/hetzner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const waitUntilGone = (id: number) =>
  Services.images.getImage({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "create, update, and delete a snapshot image",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const server = yield* Hetzner.Server("Web", {
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
          });
          return yield* Hetzner.Image("Golden", {
            server,
            description: "alchemy-image-golden",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(Number));
      expect(created.type).toEqual("snapshot");
      expect(created.status).toEqual("available");
      expect(created.description).toEqual("alchemy-image-golden");
      expect(created.createdFromId).toEqual(expect.any(Number));
      expect(created.diskSize).toEqual(expect.any(Number));
      expect(created.architecture).toEqual("x86");
      expect(created.deleteProtection).toEqual(false);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* Services.images.getImage({ id: created.id });
      expect(fetched.image?.id).toEqual(created.id);
      expect(fetched.image?.type).toEqual("snapshot");
      expect(fetched.image?.status).toEqual("available");
      expect(fetched.image?.description).toEqual("alchemy-image-golden");
      expect(fetched.image?.created_from?.id).toEqual(created.createdFromId);
      expect(fetched.image?.labels.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const server = yield* Hetzner.Server("Web", {
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
          });
          return yield* Hetzner.Image("Golden", {
            server,
            description: "alchemy-image-golden-v2",
            labels: { env: "prod", role: "golden" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.createdFromId).toEqual(created.createdFromId);
      expect(updated.description).toEqual("alchemy-image-golden-v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "golden" });

      const refetched = yield* Services.images.getImage({ id: updated.id });
      expect(refetched.image?.id).toEqual(created.id);
      expect(refetched.image?.description).toEqual("alchemy-image-golden-v2");
      expect(refetched.image?.labels.env).toEqual("prod");
      expect(refetched.image?.labels.role).toEqual("golden");

      const provider = yield* Provider.findProvider(Hetzner.Image);
      const all = yield* provider.list();
      const found = all.find((image) => image.id === created.id);
      expect(found).toBeDefined();
      expect(found?.description).toEqual("alchemy-image-golden-v2");
      expect(found?.type).toEqual("snapshot");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000, exclusive: true },
);
