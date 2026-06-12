import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";

export type ImageArchitecture = "x86_64" | "arm64";

export interface FindImageOptions {
  owners: string[];
  name: [string, ...string[]];
  architecture?: ImageArchitecture;
  description?: string;
  rootDeviceType?: "ebs" | "instance-store";
  virtualizationType?: "hvm" | "paravirtual";
}

const findLatestImage = Effect.fnUntraced(function* ({
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

const findFirstImage = Effect.fnUntraced(function* <Req = never>(
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

export const image = (options: FindImageOptions) => findLatestImage(options);

export const amazonLinux2023 = (options?: {
  architecture?: ImageArchitecture;
}) =>
  findLatestImage({
    owners: ["amazon"],
    name: ["al2023-ami-*-*"],
    architecture: options?.architecture,
    description: "Amazon Linux 2023",
  });

export const amazonLinux2 = (options?: { architecture?: ImageArchitecture }) =>
  findLatestImage({
    owners: ["amazon"],
    name: ["amzn2-ami-hvm-*-*-gp2"],
    architecture: options?.architecture,
    description: "Amazon Linux 2",
  });

export const amazonLinux = (options?: { architecture?: ImageArchitecture }) =>
  findFirstImage(
    [amazonLinux2023(options), amazonLinux2(options)],
    "Could not resolve a public Amazon Linux AMI",
  );

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
