export function claimPairingToken(
  token: string | null,
  attemptedTokens: Set<string>,
): string | null {
  if (!token || attemptedTokens.has(token)) return null;
  attemptedTokens.add(token);
  return token;
}

export interface PairingSubmissionQueue {
  readonly run: <Result>(submit: () => Promise<Result>) => Promise<Result>;
}

export function createPairingSubmissionQueue(): PairingSubmissionQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run: <Result>(submit: () => Promise<Result>) => {
      const result = tail.then(submit, submit);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
