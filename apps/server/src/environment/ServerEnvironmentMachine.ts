import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ProcessRunner from "../processRunner.ts";

/**
 * Best-effort hardware detection for the environment icon. Every probe is
 * allowed to fail: a null result means "no signal", and the client draws a
 * generic server until the user picks something in Settings → Connections.
 */

const DMI_ROOT = "/sys/class/dmi/id";

// SMBIOS 3.x System Enclosure types (table 17). Codes that describe a shape
// rather than a machine (docking stations, blades enclosures, IoT gateways)
// fall through to null on purpose.
const DMI_CHASSIS_KINDS: Readonly<Record<string, EnvironmentMachineKind>> = {
  "3": "desktop", // Desktop
  "4": "desktop", // Low Profile Desktop
  "5": "desktop", // Pizza Box
  "6": "desktop", // Mini Tower
  "7": "desktop", // Tower
  "8": "laptop", // Portable
  "9": "laptop", // Laptop
  "10": "laptop", // Notebook
  "13": "desktop", // All in One
  "14": "laptop", // Sub Notebook
  "15": "desktop", // Space-saving
  "16": "desktop", // Lunch Box
  "17": "server", // Main Server Chassis
  "18": "server", // Expansion Chassis
  "19": "server", // SubChassis
  "20": "server", // Bus Expansion Chassis
  "21": "server", // Peripheral Chassis
  "22": "server", // RAID Chassis
  "23": "server", // Rack Mount Chassis
  "24": "server", // Sealed-case PC
  "28": "server", // Blade
  "31": "laptop", // Convertible
  "32": "laptop", // Detachable
  "35": "desktop", // Mini PC
};

// Hypervisors and cloud providers write themselves into the DMI vendor or
// product strings; any hit means the box is a VM, and a VM reads as "cloud"
// regardless of the chassis type the hypervisor fakes. Hyper-V is matched on
// its "Virtual Machine" product, not the "Microsoft Corporation" vendor that
// physical Surface devices share.
const VIRTUALIZATION_MARKERS = [
  "qemu",
  "kvm",
  "bochs",
  "vmware",
  "virtualbox",
  "innotek",
  "xen",
  "parallels",
  "amazon ec2",
  "google compute engine",
  "digitalocean",
  "hetzner",
  "linode",
  "vultr",
  "scaleway",
  "openstack",
  "cloud",
  "virtual machine",
];

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** Marketing names and Intel-era model identifiers share these prefixes. */
export function machineKindFromAppleProductName(name: string): EnvironmentMachineKind | null {
  const normalized = name.trim().toLowerCase().replaceAll(/\s+/g, "");
  if (normalized.startsWith("macmini")) return "mac-mini";
  if (normalized.startsWith("macstudio")) return "mac-studio";
  if (normalized.startsWith("macbook")) return "laptop";
  if (normalized.startsWith("imac") || normalized.startsWith("macpro")) return "desktop";
  return null;
}

export function machineKindFromDmi(input: {
  readonly chassisType: string | null;
  readonly sysVendor: string | null;
  readonly productName: string | null;
}): EnvironmentMachineKind | null {
  const productName = input.productName ?? "";
  const vendorAndProduct = `${input.sysVendor ?? ""} ${productName}`.toLowerCase();
  if (VIRTUALIZATION_MARKERS.some((marker) => vendorAndProduct.includes(marker))) {
    return "cloud";
  }
  // Apple hardware booting Linux (Asahi) still reports the Apple product name.
  const appleKind = machineKindFromAppleProductName(productName);
  if (appleKind !== null) {
    return appleKind;
  }
  return input.chassisType === null ? null : (DMI_CHASSIS_KINDS[input.chassisType] ?? null);
}

const readOptionalFile = Effect.fn("readOptionalFile")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(path).pipe(
    Effect.map(normalize),
    Effect.catch(() => Effect.succeed(null)),
  );
});

const runProbe = Effect.fn("runMachineProbe")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  return yield* processRunner
    .run({
      command: input.command,
      args: input.args,
      timeout: "5 seconds",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.map((result) => (result.code === 0 ? normalize(result.stdout) : null)),
      Effect.catch(() => Effect.succeed(null)),
    );
});

// IOKit's `product` node carries the marketing name ("Mac mini (2024)") on
// Apple silicon; Intel Macs lack it, so `hw.model` ("Macmini8,1") is the
// fallback. Both are single-digit-millisecond calls.
const detectDarwinMachineKind = Effect.fn("detectDarwinMachineKind")(function* () {
  const ioreg = yield* runProbe({ command: "ioreg", args: ["-rd1", "-n", "product"] });
  const productName = ioreg?.match(/"product-name"\s*=\s*<"([^"]+)">/)?.[1] ?? null;
  const fromProductName =
    productName === null ? null : machineKindFromAppleProductName(productName);
  if (fromProductName !== null) {
    return fromProductName;
  }
  const model = yield* runProbe({ command: "sysctl", args: ["-n", "hw.model"] });
  return model === null ? null : machineKindFromAppleProductName(model);
});

const detectLinuxMachineKind = Effect.fn("detectLinuxMachineKind")(function* () {
  const [chassisType, sysVendor, productName] = yield* Effect.all([
    readOptionalFile(`${DMI_ROOT}/chassis_type`),
    readOptionalFile(`${DMI_ROOT}/sys_vendor`),
    readOptionalFile(`${DMI_ROOT}/product_name`),
  ]);
  return machineKindFromDmi({ chassisType, sysVendor, productName });
});

export const detectServerEnvironmentMachineKind = Effect.fn("detectServerEnvironmentMachineKind")(
  function* () {
    const platform = yield* HostProcessPlatform;
    switch (platform) {
      case "darwin":
        return yield* detectDarwinMachineKind();
      case "linux":
        return yield* detectLinuxMachineKind();
      default:
        return null;
    }
  },
);
