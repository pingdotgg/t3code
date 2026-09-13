import * as Effect from "effect/Effect";
import * as Output from "../../Output.ts";
import { getAmi } from "./GetAmi.ts";

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

const requireImageId = (options: FindImageOptions) =>
  getAmi(options).pipe(
    Output.mapEffect((image) =>
      image?.ImageId
        ? Effect.succeed(image.ImageId)
        : Effect.die(
            new Error(
              `Could not resolve ${options.description ?? "an AMI"} matching ${options.name.join(", ")}`,
            ),
          ),
    ),
  );

/**
 * Look up the latest available AMI ID matching the given filters.
 *
 * Returns an `Output<string>` resolved at plan/deploy time via the
 * {@link getAmi} data source (and dies with a descriptive error when
 * nothing matches), so it is safe to use both in resource props and in
 * composition code that is re-executed inside a deployed runtime — the
 * lookup never runs on the deployed machine. Use the preset helpers
 * ({@link amazonLinux2023}, {@link ubuntu2404}, ...) for common distros.
 *
 * @example Find a custom AMI
 * ```typescript
 * const instance = yield* AWS.EC2.Instance("web", {
 *   imageId: AWS.EC2.image({
 *     owners: ["amazon"],
 *     name: ["al2023-ami-ecs-hvm-*"],
 *     architecture: "arm64",
 *   }),
 *   instanceType: "t4g.micro",
 *   subnetId: subnet.subnetId,
 * });
 * ```
 */
export const image = (options: FindImageOptions) => requireImageId(options);

const amazonLinux2023Options = (options?: {
  architecture?: ImageArchitecture;
}): FindImageOptions => ({
  owners: ["amazon"],
  // `al2023-ami-2023.*` selects the standard image. The broader
  // `al2023-ami-*` also matches `al2023-ami-minimal-*`, which ships without
  // the SSM agent and a stripped toolset and frequently sorts newest.
  name: ["al2023-ami-2023.*"],
  architecture: options?.architecture,
  description: "Amazon Linux 2023",
});

const amazonLinux2Options = (options?: {
  architecture?: ImageArchitecture;
}): FindImageOptions => ({
  owners: ["amazon"],
  name: ["amzn2-ami-hvm-*-*-gp2"],
  architecture: options?.architecture,
  description: "Amazon Linux 2",
});

/**
 * Resolve the latest Amazon Linux 2023 AMI ID for the current region as an
 * `Output<string>`.
 *
 * @example Launch an Instance on Amazon Linux 2023
 * ```typescript
 * const instance = yield* AWS.EC2.Instance("web", {
 *   imageId: AWS.EC2.amazonLinux2023(),
 *   instanceType: "t3.micro",
 *   subnetId: subnet.subnetId,
 * });
 * ```
 */
export const amazonLinux2023 = (options?: {
  architecture?: ImageArchitecture;
}) => image(amazonLinux2023Options(options));

/**
 * Resolve the latest Amazon Linux 2 AMI ID for the current region as an
 * `Output<string>`.
 */
export const amazonLinux2 = (options?: { architecture?: ImageArchitecture }) =>
  image(amazonLinux2Options(options));

/**
 * Resolve the newest public Amazon Linux AMI as an `Output<string>`,
 * preferring Amazon Linux 2023 and falling back to Amazon Linux 2. Dies if
 * neither is available.
 */
export const amazonLinux = (options?: { architecture?: ImageArchitecture }) =>
  getAmi(amazonLinux2023Options(options)).pipe(
    Output.flatMap((al2023) =>
      al2023?.ImageId
        ? Output.literal(al2023.ImageId)
        : requireImageId({
            ...amazonLinux2Options(options),
            description: "a public Amazon Linux AMI",
          }),
    ),
  );

/**
 * Resolve the latest Canonical Ubuntu 24.04 LTS AMI ID for the current
 * region as an `Output<string>`.
 *
 * @example Launch an Instance on Ubuntu 24.04
 * ```typescript
 * const instance = yield* AWS.EC2.Instance("web", {
 *   imageId: AWS.EC2.ubuntu2404(),
 *   instanceType: "t3.micro",
 *   subnetId: subnet.subnetId,
 * });
 * ```
 */
export const ubuntu2404 = (options?: { architecture?: ImageArchitecture }) =>
  image({
    owners: ["099720109477"],
    name: [
      "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-*-server-*",
      "ubuntu/images/hvm-ssd/ubuntu-noble-24.04-*-server-*",
    ],
    architecture: options?.architecture,
    description: "Ubuntu 24.04 LTS",
  });

/**
 * Resolve the latest Canonical Ubuntu 22.04 LTS AMI ID for the current
 * region as an `Output<string>`.
 */
export const ubuntu2204 = (options?: { architecture?: ImageArchitecture }) =>
  image({
    owners: ["099720109477"],
    name: [
      "ubuntu/images/hvm-ssd-gp3/ubuntu-jammy-22.04-*-server-*",
      "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-*-server-*",
    ],
    architecture: options?.architecture,
    description: "Ubuntu 22.04 LTS",
  });
