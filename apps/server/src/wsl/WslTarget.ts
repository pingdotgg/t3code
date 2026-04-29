import type { ExecutionTarget } from "@t3tools/contracts";

export interface WslTarget {
  readonly kind: "wsl";
  readonly distroName: string;
  readonly user?: string | undefined;
}

export function isWslTarget(target: ExecutionTarget | undefined): target is WslTarget {
  return target?.kind === "wsl";
}

export function normalizeWslTarget(target: WslTarget): WslTarget {
  const distroName = target.distroName.trim();
  const user = target.user?.trim();
  return {
    kind: "wsl",
    distroName,
    ...(user ? { user } : {}),
  };
}

export function formatWslTarget(target: WslTarget): string {
  return target.user ? `${target.user}@${target.distroName}` : target.distroName;
}

export function localExecutionTarget(): ExecutionTarget {
  return { kind: "local" };
}
