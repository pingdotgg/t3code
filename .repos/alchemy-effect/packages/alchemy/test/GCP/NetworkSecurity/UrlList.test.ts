import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  networksecurity.getProjectsLocationsUrlLists({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsUrlLists on a missing list fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsUrlLists({
          name: `projects/${project}/locations/us-central1/urlLists/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a url list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.UrlList("Blocked", {
            location: "us-central1",
            description: "url list a",
            values: ["malware.example.com"],
          });
        }),
      );

      expect(created.name).toContain("/urlLists/");
      expect(created.name).toContain("/locations/us-central1/");
      expect(created.urlListId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("url list a");
      expect(created.values).toEqual(["malware.example.com"]);
      expect(created.createTime).toEqual(expect.any(String));

      const fetched = yield* networksecurity.getProjectsLocationsUrlLists({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.values).toEqual(["malware.example.com"]);
      expect(fetched.description ?? "").toContain("[alchemy ");
      expect(fetched.description ?? "").toContain("url list a");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.UrlList("Blocked", {
            urlListId: created.urlListId,
            location: "us-central1",
            description: "url list b",
            values: ["malware.example.com", "c2.example.net"],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("url list b");
      expect(updated.values).toEqual(["malware.example.com", "c2.example.net"]);

      const refetched = yield* networksecurity.getProjectsLocationsUrlLists({
        name: created.name,
      });
      expect(refetched.description ?? "").toContain("url list b");
      expect(refetched.values).toEqual([
        "malware.example.com",
        "c2.example.net",
      ]);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);
