import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

// IAM rejects uploading the same signing certificate body anywhere else in
// the account, even when the certificates belong to different users. The two
// live tests intentionally share one checked-in deterministic certificate, so
// serialize only their certificate lifecycles while leaving unrelated IAM and
// AWS tests concurrent.
const signingCertificateFixtureLock = Semaphore.makeUnsafe(1);

export const withSigningCertificateFixture = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    signingCertificateFixtureLock.take(1),
    () => effect,
    () => signingCertificateFixtureLock.release(1).pipe(Effect.asVoid),
  );
