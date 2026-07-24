export class VersionControlCommandInterrupted extends Error {
  constructor() {
    super("The Version Control command was interrupted.");
    this.name = "VersionControlCommandInterrupted";
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
