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

export async function runInitialRemoteFetch(options: {
  readonly cwd: string;
  readonly fetchedCwds: Set<string>;
  readonly fetch: () => Promise<unknown>;
  readonly refresh: () => Promise<unknown>;
}): Promise<boolean> {
  if (options.fetchedCwds.has(options.cwd)) return false;
  options.fetchedCwds.add(options.cwd);
  try {
    await options.fetch();
    await options.refresh();
    return true;
  } catch {
    options.fetchedCwds.delete(options.cwd);
    return false;
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
