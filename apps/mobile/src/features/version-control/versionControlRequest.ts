export class VersionControlCommandInterrupted extends Error {
  constructor() {
    super("The Version Control command was interrupted.");
    this.name = "VersionControlCommandInterrupted";
  }
}

export const VERSION_CONTROL_CHECKOUT_ACTION_OPTIONS = {
  reportFailure: false,
  throwOnFailure: true,
} as const;

export function retainPullRefreshIndicator(current: boolean, pullRequest: boolean): boolean {
  return current || pullRequest;
}

export interface VersionControlRefreshOptions {
  readonly pull?: boolean;
  readonly refresh?: "full" | "working-tree";
}

export function mergeVersionControlRefreshOptions(
  current: VersionControlRefreshOptions | null,
  next: VersionControlRefreshOptions,
): VersionControlRefreshOptions {
  return {
    ...(current?.pull === true || next.pull === true ? { pull: true } : {}),
    refresh:
      next.refresh !== "working-tree" || (current !== null && current.refresh !== "working-tree")
        ? "full"
        : "working-tree",
  };
}

export async function runAutomaticRemoteFetch(options: {
  readonly cwd: string;
  readonly inFlightCwds: Set<string>;
  readonly fetch: () => Promise<boolean>;
  readonly refresh: () => Promise<unknown>;
}): Promise<boolean> {
  if (options.inFlightCwds.has(options.cwd)) return false;
  options.inFlightCwds.add(options.cwd);
  try {
    const fetched = await options.fetch();
    if (fetched) await options.refresh();
    return fetched;
  } catch {
    return false;
  } finally {
    options.inFlightCwds.delete(options.cwd);
  }
}

export async function retryInterruptedVersionControlRequest<TResult>(
  request: () => Promise<TResult>,
  maxRetries = 1,
): Promise<TResult> {
  let retries = 0;
  while (true) {
    try {
      return await request();
    } catch (cause) {
      if (!(cause instanceof VersionControlCommandInterrupted) || retries >= maxRetries) {
        throw cause;
      }
      retries += 1;
    }
  }
}
