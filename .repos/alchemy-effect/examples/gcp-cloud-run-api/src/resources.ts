import * as GCP from "alchemy/GCP";

/**
 * One Firestore document per short link, at `links/{code}`. Firestore is
 * the default datastore for a Cloud Run app: no instance to size, no VPC
 * to attach, and it is reachable over the same googleapis endpoint the
 * rest of the bindings use.
 */
export const Links = GCP.Firestore.Database("Links", {
  type: "FIRESTORE_NATIVE",
});

/**
 * The key callers must present to create a link. Only the container ever
 * reads it — the value never appears in the stack, in an env var set by
 * hand, or in `alchemy deploy` output.
 *
 * Alchemy creates the secret; adding the *version* that holds the value
 * is an operator step, exactly as in production:
 *
 * ```sh
 * printf 'my-key' | gcloud secrets versions add "$SECRET_ID" --data-file=-
 * ```
 */
export const ApiKey = GCP.SecretManager.Secret("ApiKey", {});
