import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import { DATA_DEVICE, MARKER, REGION, webVm, ZONE } from "./fixtures/web-vm.ts";
import { DEFAULT_NETWORK } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

class PageNotServed extends Data.TaggedError("PageNotServed")<{
  readonly reason: string;
}> {}

class StillExists extends Data.TaggedError("StillExists")<{
  readonly what: string;
}> {}

// Poll the static IP until the startup script's HTTP server answers with the
// marker page. Transport errors (VM still booting) count as "not ready".
const fetchPage = (ip: string) =>
  HttpClient.get(`http://${ip}/index.html`).pipe(
    Effect.timeout("5 seconds"),
    Effect.flatMap(
      (
        res,
      ): Effect.Effect<
        string,
        HttpClientError.HttpClientError | PageNotServed
      > =>
        res.status === 200
          ? res.text
          : Effect.fail(new PageNotServed({ reason: `status ${res.status}` })),
    ),
    Effect.flatMap((body) =>
      body.includes(MARKER)
        ? Effect.succeed(body)
        : Effect.fail(new PageNotServed({ reason: `body ${body}` })),
    ),
    Effect.mapError((error) =>
      error instanceof PageNotServed
        ? error
        : new PageNotServed({ reason: String(error) }),
    ),
    Effect.retry({
      while: (error) => error._tag === "PageNotServed",
      schedule: Schedule.spaced("5 seconds"),
      times: 60,
    }),
  );

// Bounded wait until an out-of-band probe reports the resource gone.
const waitUntilGone = <E, R>(
  what: string,
  probe: Effect.Effect<boolean, E, R>,
) =>
  probe.pipe(
    Effect.flatMap((gone) =>
      gone ? Effect.void : Effect.fail(new StillExists({ what })),
    ),
    Effect.retry({
      while: (error) => error instanceof StillExists,
      schedule: Schedule.spaced("3 seconds"),
      times: 20,
    }),
  );

// GCP counterpart of the AWS EC2 Instance + Storage smokes: a Debian VM in its
// project's `default` network behind a tcp:80 firewall, reachable on a reserved static IP, with an
// extra persistent disk attached. Heavy (VM boot), so skipped under `FAST=1`.
test.provider.skipIf(!!process.env.FAST)(
  "deploys a VM with a static IP and data disk that serves HTTP, updates in place, and tears down",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(webVm("initial"));

      expect(created.status).toEqual("RUNNING");
      expect(created.address).toEqual(expect.any(String));
      expect(created.natIP).toEqual(created.address);
      expect(created.attachedDisks).toEqual([
        expect.objectContaining({
          source: expect.stringContaining(`/disks/${created.diskName}`),
          deviceName: DATA_DEVICE,
          mode: "READ_WRITE",
        }),
      ]);

      // Out-of-band: the VM runs with the static IP and the data disk attached.
      const vm = yield* compute.getInstances({
        project,
        zone: ZONE,
        instance: created.instanceName,
      });
      expect(vm.status).toEqual("RUNNING");
      expect(vm.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP).toEqual(
        created.address,
      );
      expect(vm.networkInterfaces?.[0]?.subnetwork).toContain(
        `/subnetworks/${DEFAULT_NETWORK}`,
      );
      expect(
        vm.disks?.some(
          (d) =>
            d.boot !== true &&
            d.deviceName === DATA_DEVICE &&
            d.source?.endsWith(`/disks/${created.diskName}`),
        ),
      ).toBe(true);
      const disk = yield* compute.getDisks({
        project,
        zone: ZONE,
        disk: created.diskName,
      });
      expect(disk.users ?? []).toEqual([
        expect.stringContaining(`/instances/${created.instanceName}`),
      ]);
      const address = yield* compute.getAddresses({
        project,
        region: REGION,
        address: created.addressName,
      });
      expect(address.status).toEqual("IN_USE");

      // In-band: the startup script serves the marker page on the static IP
      // and sees the data disk as a guest block device.
      const page = yield* fetchPage(created.address!);
      expect(page).toContain(`host=${created.instanceName}`);
      expect(page).toContain("disk=present");

      // Label + metadata change reconciles in place (same instance id).
      const updated = yield* stack.deploy(webVm("updated"));
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.instanceName).toEqual(created.instanceName);
      expect(updated.labels).toMatchObject({
        smoke: "instance",
        phase: "updated",
      });
      expect(updated.metadata).toMatchObject({ "smoke-phase": "updated" });
      expect(updated.natIP).toEqual(created.address);

      const vm2 = yield* compute.getInstances({
        project,
        zone: ZONE,
        instance: created.instanceName,
      });
      expect(vm2.id).toEqual(created.instanceId);
      expect(vm2.labels?.phase).toEqual("updated");
      expect(
        vm2.metadata?.items?.find((item) => item.key === "smoke-phase")?.value,
      ).toEqual("updated");
      expect(vm2.disks?.filter((d) => d.boot !== true)).toHaveLength(1);
      const updatedPage = yield* fetchPage(created.address!);
      expect(updatedPage).toContain(MARKER);

      yield* stack.destroy();

      // Zero-orphan proof for every billed / named resource.
      yield* waitUntilGone(
        "instance",
        compute
          .getInstances({
            project,
            zone: ZONE,
            instance: created.instanceName,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          ),
      );
      yield* waitUntilGone(
        "disk",
        compute.getDisks({ project, zone: ZONE, disk: created.diskName }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      );
      yield* waitUntilGone(
        "address",
        compute
          .getAddresses({
            project,
            region: REGION,
            address: created.addressName,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          ),
      );
      yield* waitUntilGone(
        "firewall",
        compute.getFirewalls({ project, firewall: created.firewallName }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      );
    }),
  {
    tags: ["provider:gcp", "provider:gcp:compute", "smoke", "live"],
    timeout: 900_000,
  },
);
