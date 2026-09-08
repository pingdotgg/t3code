import * as Data from "effect/Data";

/**
 * A {@link Bucket}'s Tigris credentials could not be resolved when a
 * bound S3 operation ran.
 *
 * Tigris hands out the access key pair once, at add-on creation. If the
 * Bucket attributes reaching the binding carry no key pair — an adopted
 * bucket, or one whose create-only secrets were never persisted — the
 * operation fails with this instead of signing an anonymous request.
 */
export class TigrisCredentialsMissing extends Data.TaggedError(
  "Fly.TigrisCredentialsMissing",
)<{
  name: string;
}> {}
