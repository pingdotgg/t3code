import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { DEFAULT_NETWORK } from "../../networkQuota.ts";

export const REGION = "us-central1";
export const ZONE = "us-central1-a";
export const MARKER = "alchemy-gcp-instance-smoke";
export const DATA_DEVICE = "smoke-data";
export const WEB_TAG = "alchemy-smoke-web";

/**
 * Boots a tiny HTTP server on :80 serving `/index.html`, which carries the
 * marker, the hostname, and whether the extra data disk is visible to the
 * guest (`/dev/disk/by-id/google-{DATA_DEVICE}`).
 */
const STARTUP_SCRIPT = `#!/bin/bash
set -eu
mkdir -p /srv/www
if [ -e /dev/disk/by-id/google-${DATA_DEVICE} ]; then DISK=present; else DISK=missing; fi
printf '%s host=%s disk=%s\\n' '${MARKER}' "$(hostname)" "$DISK" > /srv/www/index.html
cd /srv/www
nohup python3 -m http.server 80 >/var/log/smoke-http.log 2>&1 &
`;

/**
 * A tcp:80 firewall on the project's `default` network, a static external address, an extra
 * data disk, and an e2-micro Debian VM that uses all of them. `phase` drives
 * the label/metadata update step of the smoke.
 */
export const webVm = (phase: "initial" | "updated") =>
  Effect.gen(function* () {
    const firewall = yield* GCP.Compute.Firewall("SmokeAllowHttp", {
      network: DEFAULT_NETWORK,
      allowed: [{ protocol: "tcp", ports: ["80"] }],
      sourceRanges: ["0.0.0.0/0"],
      targetTags: [WEB_TAG],
    });
    const address = yield* GCP.Compute.Address("SmokeAddress", {
      region: REGION,
    });
    const disk = yield* GCP.Compute.Disk("SmokeData", {
      zone: ZONE,
      sizeGb: 10,
    });
    const instance = yield* GCP.Compute.Instance("SmokeVm", {
      zone: ZONE,
      machineType: "e2-micro",
      sourceImage: "projects/debian-cloud/global/images/family/debian-12",
      network: `global/networks/${DEFAULT_NETWORK}`,
      // The auto-mode `default` network's subnet in REGION is also `default`.
      subnetwork: `regions/${REGION}/subnetworks/${DEFAULT_NETWORK}`,
      natIP: address.address.as<string>(),
      attachedDisks: [
        {
          source: disk.selfLink.as<string>(),
          deviceName: DATA_DEVICE,
        },
      ],
      tags: [WEB_TAG],
      labels:
        phase === "initial"
          ? { smoke: "instance" }
          : { smoke: "instance", phase: "updated" },
      metadata: {
        "startup-script": STARTUP_SCRIPT,
        "smoke-phase": phase,
      },
    });
    return {
      instanceName: instance.instanceName,
      instanceId: instance.instanceId,
      status: instance.status,
      natIP: instance.natIP,
      labels: instance.labels,
      metadata: instance.metadata,
      attachedDisks: instance.attachedDisks,
      addressName: address.addressName,
      address: address.address,
      diskName: disk.diskName,
      firewallName: firewall.firewallName,
    };
  });
