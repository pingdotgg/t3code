import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (project: string, firewall: string) =>
  compute.getFirewalls({ project, firewall }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, replace, and delete a firewall",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Firewall("AllowHttp", {
            description: "test http",
            allowed: [{ protocol: "tcp", ports: ["80"] }],
            sourceRanges: ["10.0.0.0/8"],
            targetTags: ["alchemy-fw"],
          });
        }),
      );

      expect(created.firewallName).toEqual(expect.any(String));
      expect(created.direction).toEqual("INGRESS");
      expect(created.disabled).toEqual(false);
      expect(created.priority).toEqual(1000);
      expect(created.description).toEqual("test http");
      expect(created.allowed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ protocol: "tcp", ports: ["80"] }),
        ]),
      );
      expect(created.sourceRanges).toEqual(["10.0.0.0/8"]);
      expect(created.targetTags).toEqual(["alchemy-fw"]);
      expect(created.network).toEqual(expect.stringContaining("networks/"));

      const fetched = yield* compute.getFirewalls({
        project: created.project,
        firewall: created.firewallName,
      });
      expect(fetched.name).toEqual(created.firewallName);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("test http");
      expect(fetched.allowed?.[0]?.IPProtocol).toEqual("tcp");
      expect(fetched.sourceRanges).toEqual(["10.0.0.0/8"]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Firewall("AllowHttp", {
            firewallName: created.firewallName,
            description: "updated http",
            allowed: [{ protocol: "tcp", ports: ["80", "443"] }],
            sourceRanges: ["10.0.0.0/8"],
            targetTags: ["alchemy-fw", "web"],
            priority: 800,
            disabled: true,
          });
        }),
      );

      expect(updated.firewallName).toEqual(created.firewallName);
      expect(updated.id).toEqual(created.id);
      expect(updated.description).toEqual("updated http");
      expect(updated.priority).toEqual(800);
      expect(updated.disabled).toEqual(true);
      expect(updated.targetTags.sort()).toEqual(["alchemy-fw", "web"].sort());
      expect(updated.allowed[0]?.ports?.sort()).toEqual(["443", "80"]);

      const fetchedUpdate = yield* compute.getFirewalls({
        project: updated.project,
        firewall: updated.firewallName,
      });
      expect(fetchedUpdate.priority).toEqual(800);
      expect(fetchedUpdate.disabled).toEqual(true);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Firewall("AllowHttp", {
            firewallName: created.firewallName,
            description: "egress https",
            direction: "EGRESS",
            allowed: [{ protocol: "tcp", ports: ["443"] }],
            destinationRanges: ["10.0.0.0/8"],
            targetTags: ["alchemy-fw"],
          });
        }),
      );

      expect(replaced.firewallName).toEqual(created.firewallName);
      expect(replaced.direction).toEqual("EGRESS");
      expect(replaced.destinationRanges).toEqual(["10.0.0.0/8"]);
      expect(replaced.id).not.toEqual(created.id);

      const fetchedReplace = yield* compute.getFirewalls({
        project: replaced.project,
        firewall: replaced.firewallName,
      });
      expect((fetchedReplace.direction ?? "").toUpperCase()).toEqual("EGRESS");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.firewallName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
