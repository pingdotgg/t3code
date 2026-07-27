import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";

/**
 * CPU architecture of the AMI to look up.
 */
export type ImageArchitecture = "x86_64" | "arm64";

/**
 * Filters for looking up the latest matching public AMI via
 * `ec2:DescribeImages`.
 */
export interface FindImageOptions {
  /**
   * AMI owners to search, e.g. `["amazon"]` or a vendor account ID like
   * Canonical's `"099720109477"`.
   */
  owners: string[];
  /**
   * One or more AMI name patterns (glob-style). The newest available image
   * matching any pattern wins.
   */
  name: [string, ...string[]];
  /**
   * CPU architecture to filter on.
   * @default "x86_64"
   */
  architecture?: ImageArchitecture;
  /**
   * Human-readable label for the lookup (informational only).
   */
  description?: string;
  /**
   * Root device type to filter on.
   * @default "ebs"
   */
  rootDeviceType?: "ebs" | "instance-store";
  /**
   * Virtualization type to filter on.
   * @default "hvm"
   */
  virtualizationType?: "hvm" | "paravirtual";
}

const findLatestImage = Effect.fn(function* ({
  owners,
  name,
  architecture = "x86_64",
  // description = "public image",
  rootDeviceType = "ebs",
  virtualizationType = "hvm",
}: FindImageOptions) {
  const response = yield* ec2
    .describeImages({
      Owners: owners,
      Filters: [
        { Name: "name", Values: [...name] },
        { Name: "architecture", Values: [architecture] },
        { Name: "state", Values: ["available"] },
        { Name: "root-device-type", Values: [rootDeviceType] },
        { Name: "virtualization-type", Values: [virtualizationType] },
      ],
    })
    .pipe(Effect.orDie);

  const latest = (response.Images ?? [])
    .slice()
    .sort((a: ec2.Image, b: ec2.Image) =>
      String(b.CreationDate ?? "").localeCompare(String(a.CreationDate ?? "")),
    )[0];

  if (!latest?.ImageId) {
    return undefined;
  }

  return latest.ImageId;
});

const findFirstImage = Effect.fn(function* <Req = never>(
  lookups: ReadonlyArray<Effect.Effect<string | undefined, never, Req>>,
  errorMessage: string,
) {
  for (const lookup of lookups) {
    const result = yield* lookup;
    if (result) {
      return result;
    }
  }
  return yield* Effect.die(new Error(errorMessage));
});

/**
 * Look up the latest available AMI ID matching the given filters, or
 * `undefined` when nothing matches. Use the preset helpers
 * ({@link amazonLinux2023}, {@link ubuntu2404}, ...) for common distros.
 *
 * @example Find a custom AMI
 * ```typescript
 * const imageId = yield* AWS.EC2.image({
 *   owners: ["amazon"],
 *   name: ["al2023-ami-ecs-hvm-*"],
 *   architecture: "arm64",
 * });
 * ```
 */
export const image = (options: FindImageOptions) => findLatestImage(options);

/**
 * Resolve the latest Amazon Linux 2023 AMI ID for the current region.
 *
 * @example Launch an Instance on Amazon Linux 2023
 * ```typescript
 * const imageId = yield* AWS.EC2.amazonLinux2023();
 *
 * const instance = yield* AWS.EC2.Instance("web", {
 *   imageId: imageId!,
 *   instanceType: "t3.micro",
 *   subnetId: subnet.subnetId,
 * });
 * ```
 */
export const amazonLinux2023 = (options?: {
  architecture?: ImageArchitecture;
}) =>
  findLatestImage({
    owners: ["amazon"],
    // `al2023-ami-2023.*` selects the standard image. The broader
    // `al2023-ami-*` also matches `al2023-ami-minimal-*`, which ships without
    // the SSM agent and a stripped toolset and frequently sorts newest.
    name: ["al2023-ami-2023.*"],
    architecture: options?.architecture,
    description: "Amazon Linux 2023",
  });

/**
 * Resolve the latest Amazon Linux 2 AMI ID for the current region.
 */
export const amazonLinux2 = (options?: { architecture?: ImageArchitecture }) =>
  findLatestImage({
    owners: ["amazon"],
    name: ["amzn2-ami-hvm-*-*-gp2"],
    architecture: options?.architecture,
    description: "Amazon Linux 2",
  });

/**
 * Resolve the newest public Amazon Linux AMI, preferring Amazon Linux 2023
 * and falling back to Amazon Linux 2. Dies if neither is available.
 */
export const amazonLinux = (options?: { architecture?: ImageArchitecture }) =>
  findFirstImage(
    [amazonLinux2023(options), amazonLinux2(options)],
    "Could not resolve a public Amazon Linux AMI",
  );

/**
 * Resolve the latest Canonical Ubuntu 24.04 LTS AMI ID for the current region.
 */
export const ubuntu2404 = (options?: { architecture?: ImageArchitecture }) =>
  findLatestImage({
    owners: ["099720109477"],
    name: [
      "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-*-server-*",
      "ubuntu/images/hvm-ssd/ubuntu-noble-24.04-*-server-*",
    ],
    architecture: options?.architecture,
    description: "Ubuntu 24.04 LTS",
  });

/**
 * Resolve the latest Canonical Ubuntu 22.04 LTS AMI ID for the current region.
 */
export const ubuntu2204 = (options?: { architecture?: ImageArchitecture }) =>
  findLatestImage({
    owners: ["099720109477"],
    name: [
      "ubuntu/images/hvm-ssd-gp3/ubuntu-jammy-22.04-*-server-*",
      "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-*-server-*",
    ],
    architecture: options?.architecture,
    description: "Ubuntu 22.04 LTS",
  });
