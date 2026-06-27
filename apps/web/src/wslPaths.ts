export interface WslUncPath {
  readonly distro: string;
  readonly linuxPath: string;
}

export interface WslEnvironmentCandidate<TEnvironmentId extends string = string> {
  readonly environmentId: TEnvironmentId;
  readonly backendId: string;
}

export interface WslProjectSelection<TEnvironmentId extends string = string> extends WslUncPath {
  readonly environmentId: TEnvironmentId;
}

const WSL_UNC_PREFIXES = ["\\\\wsl.localhost\\", "\\\\wsl$\\"] as const;
const WSL_DISTRO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function parseWslUncPath(input: string): WslUncPath | null {
  const normalized = input.trim().replaceAll("/", "\\");
  const prefix = WSL_UNC_PREFIXES.find((candidate) =>
    normalized.toLowerCase().startsWith(candidate.toLowerCase()),
  );
  if (!prefix) {
    return null;
  }

  const rest = normalized.slice(prefix.length);
  const segments = rest.split("\\").filter((segment) => segment.length > 0);
  const distro = segments.shift();
  if (!distro || !WSL_DISTRO_NAME_PATTERN.test(distro)) {
    return null;
  }

  return {
    distro,
    linuxPath: segments.length === 0 ? "/" : `/${segments.join("/")}`,
  };
}

export function resolveWslProjectSelection<TEnvironmentId extends string>(
  input: string,
  candidates: ReadonlyArray<WslEnvironmentCandidate<TEnvironmentId>>,
): WslProjectSelection<TEnvironmentId> | null {
  const parsed = parseWslUncPath(input);
  if (!parsed) {
    return null;
  }

  const wslCandidates = candidates.filter((candidate) => candidate.backendId.startsWith("wsl:"));
  const exact = wslCandidates.find(
    (candidate) => candidate.backendId.toLowerCase() === `wsl:${parsed.distro}`.toLowerCase(),
  );
  const candidate = exact ?? (wslCandidates.length === 1 ? wslCandidates[0] : undefined);
  return candidate ? { ...parsed, environmentId: candidate.environmentId } : null;
}
