import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

const waitUntilGone = (urlMapName: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getUrlMaps({ project, urlMap: urlMapName }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (status) => status === "gone",
          times: 10,
        }),
      ),
    ),
  );

test.provider(
  "create, update, and delete a url map",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.UrlMap("Web", {
            description: "https redirect",
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.com",
              stripQuery: false,
            },
          });
        }),
      );

      expect(created.urlMapName).toEqual(expect.any(String));
      expect(created.description).toEqual("https redirect");
      expect(created.defaultUrlRedirect?.httpsRedirect).toEqual(true);
      expect(created.defaultUrlRedirect?.hostRedirect).toEqual("example.com");

      const fetched = yield* compute.getUrlMaps({
        project,
        urlMap: created.urlMapName,
      });
      expect(fetched.name).toEqual(created.urlMapName);
      expect(fetched.defaultUrlRedirect?.hostRedirect).toEqual("example.com");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("https redirect");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.UrlMap("Web", {
            urlMapName: created.urlMapName,
            description: "host rules",
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.org",
              stripQuery: true,
            },
            hostRules: [{ hosts: ["example.org"], pathMatcher: "all" }],
            pathMatchers: [
              {
                name: "all",
                defaultUrlRedirect: {
                  httpsRedirect: true,
                  hostRedirect: "www.example.org",
                  stripQuery: false,
                },
              },
            ],
          });
        }),
      );

      expect(updated.urlMapName).toEqual(created.urlMapName);
      expect(updated.description).toEqual("host rules");
      expect(updated.defaultUrlRedirect?.hostRedirect).toEqual("example.org");
      expect(updated.defaultUrlRedirect?.stripQuery).toEqual(true);
      expect(updated.hostRules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pathMatcher: "all",
            hosts: expect.arrayContaining(["example.org"]),
          }),
        ]),
      );
      expect(updated.pathMatchers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "all",
            defaultUrlRedirect: expect.objectContaining({
              hostRedirect: "www.example.org",
            }),
          }),
        ]),
      );

      const refetched = yield* compute.getUrlMaps({
        project,
        urlMap: updated.urlMapName,
      });
      expect(refetched.defaultUrlRedirect?.hostRedirect).toEqual("example.org");
      expect(refetched.hostRules?.[0]?.pathMatcher).toEqual("all");
      expect(refetched.pathMatchers?.[0]?.name).toEqual("all");
      expect(refetched.description).toContain("host rules");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.urlMapName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
