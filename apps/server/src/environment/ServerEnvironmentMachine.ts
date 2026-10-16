import type { EnvironmentMachineKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ProcessRunner from "../processRunner.ts";

const DMI_ROOT = "/sys/class/dmi/id";
const KERNEL_RELEASE_PATH = "/proc/sys/kernel/osrelease";

// SMBIOS 3.x System Enclosure types (table 17).
const DMI_CHASSIS_KINDS: Readonly<Record<string, EnvironmentMachineKind>> = {
  "3": "desktop",
  "4": "desktop",
  "5": "desktop",
  "6": "desktop",
  "7": "desktop",
  "8": "laptop",
  "9": "laptop",
  "10": "laptop",
  "13": "desktop",
  "14": "laptop",
  "15": "desktop",
  "16": "desktop",
  "17": "server",
  "18": "server",
  "19": "server",
  "20": "server",
  "21": "server",
  "22": "server",
  "23": "server",
  "24": "server",
  "28": "server",
  "31": "laptop",
  "32": "laptop",
  "35": "desktop",
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
    Effect.orElseSucceed(() => null),
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
      Effect.orElseSucceed(() => null),
    );
});

// IOKit's `product` node carries the marketing name ("Mac mini (2024)") on
// Apple silicon; Intel Macs lack it, so `hw.model` ("Macmini8,1") is the
// fallback.
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
  const [kernelRelease, chassisType, sysVendor, productName] = yield* Effect.all([
    readOptionalFile(KERNEL_RELEASE_PATH),
    readOptionalFile(`${DMI_ROOT}/chassis_type`),
    readOptionalFile(`${DMI_ROOT}/sys_vendor`),
    readOptionalFile(`${DMI_ROOT}/product_name`),
  ]);
  // WSL exposes Microsoft in its kernel release on both WSL 1 and WSL 2.
  // Check it before DMI because WSL 2 presents as a Hyper-V VM.
  if (kernelRelease?.toLowerCase().includes("microsoft")) {
    return "linux";
  }
  return machineKindFromDmi({ chassisType, sysVendor, productName });
});

export const detectServerEnvironmentMachineKind = Effect.fn("detectServerEnvironmentMachineKind")(
  function* () {
    const platform = yield* HostProcess.Platform;
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
