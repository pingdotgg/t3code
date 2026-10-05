import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as websecurityscanner from "@distilled.cloud/gcp/websecurityscanner_v1";
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
const missingNameOf = (project: string) => `projects/${project}/scanConfigs/1`;

const waitUntilGone = (name: string) =>
  websecurityscanner.getProjectsScanConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsScanConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        websecurityscanner.getProjectsScanConfigs({
          name: missingNameOf(project),
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* websecurityscanner.listProjectsScanConfigs({
        parent: `projects/${project}`,
        pageSize: 10,
      });
      expect(
        (page.scanConfigs ?? []).map((config) => config.name),
      ).not.toContain(missingNameOf(project));

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:websecurityscanner", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "createProjectsScanConfigs with an unreserved IP fails with StartingUrlIpNotReserved",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      // 203.0.113.0/24 is TEST-NET-3; it can never be reserved in the project.
      const error = yield* Effect.flip(
        websecurityscanner.createProjectsScanConfigs({
          parent: `projects/${project}`,
          body: {
            displayName: "unreserved",
            startingUrls: ["http://203.0.113.9/"],
            targetPlatforms: ["COMPUTE"],
            exportToSecurityCommandCenter: "DISABLED",
          },
        }),
      );
      expect(error._tag).toEqual("StartingUrlIpNotReserved");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:websecurityscanner", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a scan config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const reserved = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Address("ScannerIp", {
            region: "us-central1",
          });
        }),
      );
      expect(reserved.address).toEqual(expect.any(String));
      const startingUrl = `http://${reserved.address}`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ip = yield* GCP.Compute.Address("ScannerIp", {
            addressName: reserved.addressName,
            region: "us-central1",
          });
          const scan = yield* GCP.WebSecurityScanner.ScanConfig("Scan", {
            displayName: "alchemy scan",
            startingUrls: [startingUrl],
            targetPlatforms: ["COMPUTE"],
            maxQps: 5,
            userAgent: "CHROME_LINUX",
            exportToSecurityCommandCenter: "DISABLED",
            riskLevel: "LOW",
          });
          return { ip, scan };
        }),
      );

      expect(created.scan.name).toContain("/scanConfigs/");
      expect(created.scan.scanConfigId).toEqual(expect.any(String));
      expect(created.scan.displayName).toEqual("alchemy scan");
      expect(created.scan.startingUrls).toEqual([
        `http://${created.ip.address}`,
      ]);
      expect(created.scan.maxQps).toEqual(5);
      expect(created.scan.userAgent).toEqual("CHROME_LINUX");
      expect(created.scan.targetPlatforms).toEqual(["COMPUTE"]);
      expect(created.scan.exportToSecurityCommandCenter).toEqual("DISABLED");
      expect(created.scan.riskLevel).toEqual("LOW");

      const fetched = yield* websecurityscanner.getProjectsScanConfigs({
        name: created.scan.name,
      });
      expect(fetched.name).toEqual(created.scan.name);
      expect(fetched.displayName).toEqual("alchemy scan");
      expect(fetched.startingUrls).toEqual([`http://${created.ip.address}`]);
      expect(fetched.maxQps).toEqual(5);
      expect(fetched.targetPlatforms).toEqual(["COMPUTE"]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ip = yield* GCP.Compute.Address("ScannerIp", {
            addressName: created.ip.addressName,
            region: "us-central1",
          });
          const scan = yield* GCP.WebSecurityScanner.ScanConfig("Scan", {
            scanConfigId: created.scan.scanConfigId,
            displayName: "alchemy scan v2",
            startingUrls: [startingUrl],
            targetPlatforms: ["COMPUTE"],
            maxQps: 10,
            userAgent: "CHROME_ANDROID",
            blacklistPatterns: [`${startingUrl}/logout`],
            ignoreHttpStatusErrors: true,
            exportToSecurityCommandCenter: "DISABLED",
            riskLevel: "LOW",
          });
          return { ip, scan };
        }),
      );

      expect(updated.scan.name).toEqual(created.scan.name);
      expect(updated.scan.scanConfigId).toEqual(created.scan.scanConfigId);
      expect(updated.scan.displayName).toEqual("alchemy scan v2");
      expect(updated.scan.maxQps).toEqual(10);
      expect(updated.scan.userAgent).toEqual("CHROME_ANDROID");
      expect(updated.scan.blacklistPatterns).toEqual([
        `http://${updated.ip.address}/logout`,
      ]);
      expect(updated.scan.ignoreHttpStatusErrors).toEqual(true);

      const fetchedUpdate = yield* websecurityscanner.getProjectsScanConfigs({
        name: created.scan.name,
      });
      expect(fetchedUpdate.displayName).toEqual("alchemy scan v2");
      expect(fetchedUpdate.maxQps).toEqual(10);
      expect(fetchedUpdate.userAgent).toEqual("CHROME_ANDROID");
      expect(fetchedUpdate.ignoreHttpStatusErrors).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.scan.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:websecurityscanner", "live"],
    timeout: 90_000,
  },
);
