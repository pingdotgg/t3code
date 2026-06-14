export type LinuxPackageArch = "arm64" | "x64";

export function resolveLinuxPackageArch(
  architecture: NodeJS.Architecture,
): LinuxPackageArch | undefined {
  if (architecture === "arm64") return "arm64";
  if (architecture === "x64") return "x64";
  return undefined;
}

export function toDebArch(architecture: LinuxPackageArch): "amd64" | "arm64" {
  return architecture === "x64" ? "amd64" : "arm64";
}

export function toRpmArch(architecture: LinuxPackageArch): "aarch64" | "x86_64" {
  return architecture === "x64" ? "x86_64" : "aarch64";
}

export interface RpmVersion {
  readonly version: string;
  readonly release: string;
}

export interface DebVersion {
  readonly upstream: string;
  readonly revision: string;
}

export function toDebVersion(version: string): DebVersion {
  const [withoutBuild = version, ...buildParts] = version.split("+");
  const [core = withoutBuild, ...prereleaseParts] = withoutBuild.split("-");
  const prerelease = prereleaseParts.join("-");
  const build = buildParts.join("+");
  const upstreamParts = [
    core,
    ...(prerelease.length === 0 ? [] : [`~${prerelease}`]),
    ...(build.length === 0 ? [] : [`+${build}`]),
  ];
  return {
    upstream: upstreamParts.join(""),
    revision: "1",
  };
}

export function toRpmVersion(version: string): RpmVersion {
  const [withoutBuild = version, ...buildParts] = version.split("+");
  const [core = withoutBuild, ...prereleaseParts] = withoutBuild.split("-");
  const prerelease = prereleaseParts.join("-");
  const build = buildParts.join("+");
  const releaseParts = [
    prerelease.length === 0 ? "1" : `0.1.${prerelease}`,
    ...(build.length === 0 ? [] : [build]),
  ];
  return {
    version: core,
    release: releaseParts.join(".").replace(/[^0-9A-Za-z.]+/g, "."),
  };
}
