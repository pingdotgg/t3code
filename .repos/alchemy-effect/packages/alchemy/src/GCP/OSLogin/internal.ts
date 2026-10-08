import * as oslogin from "@distilled.cloud/gcp/oslogin_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export const DEFAULT_USER = "me";

export type ParsedSshKey = {
  type: string;
  blob: string;
  comment: string | undefined;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const parseSshKey = (key: string | undefined): ParsedSshKey => {
  const trimmed = (key ?? "").trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    return { type: "", blob: trimmed, comment: undefined };
  }
  const type = parts[0] ?? "";
  const blob = parts[1] ?? "";
  const comment = parts.slice(2).join(" ").trim();
  return {
    type,
    blob,
    comment: comment.length > 0 ? comment : undefined,
  };
};

export const formatSshKey = (parsed: ParsedSshKey): string =>
  [parsed.type, parsed.blob, parsed.comment]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" ");

export const keyIdentity = (key: string | undefined) => {
  const parsed = parseSshKey(key);
  return `${parsed.type} ${parsed.blob}`.trim();
};

export const sameKeyMaterial = (
  left: string | undefined,
  right: string | undefined,
) => keyIdentity(left) === keyIdentity(right);

export const normalizeUser = (user: string | undefined) => {
  const raw = (user ?? DEFAULT_USER).trim();
  const id = raw.startsWith("users/") ? raw.slice("users/".length) : raw;
  return id.length > 0 ? id : DEFAULT_USER;
};

export const toUserId = (
  requested: string | undefined,
  existing: string | undefined,
) => normalizeUser(requested ?? existing ?? DEFAULT_USER);

export const toUserParent = (user: string) => {
  const id = normalizeUser(user);
  return id.startsWith("users/") ? id : `users/${id}`;
};

export const userOf = (name: string | undefined, fallback = DEFAULT_USER) => {
  if (!name) return fallback;
  const match = name.match(/^users\/([^/]+)/);
  return match?.[1] ?? fallback;
};

export const fingerprintOf = (
  name: string | undefined,
  fingerprint?: string,
) => {
  if (fingerprint && fingerprint.length > 0) return fingerprint;
  if (!name) return "";
  const parts = name.split("/sshPublicKeys/");
  return parts[1] ?? "";
};

export const resourceName = (user: string, fingerprint: string) =>
  `${toUserParent(user)}/sshPublicKeys/${fingerprint}`;

const emptyList = <A>() => Effect.succeed([] as A[]);

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (
        error,
      ): error is E & {
        readonly _tag: "NotFound" | "Conflict";
      } => error._tag === "NotFound" || error._tag === "Conflict",
      () => Effect.void,
    ),
  );

export const retryConflict = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("400 millis"),
    }),
  );

export const getSshPublicKey = (name: string) => {
  if (name.length === 0) return Effect.succeed(undefined);
  return catchMissing(oslogin.getUsersSshPublicKeys({ name }));
};

export const listSshPublicKeys = (user: string, project?: string) =>
  oslogin
    .getLoginProfileUsers({
      name: toUserParent(user),
      projectId: project,
    })
    .pipe(
      Effect.map((profile) =>
        Object.values(profile.sshPublicKeys ?? {}).filter(
          (key): key is oslogin.SshPublicKey => key !== undefined,
        ),
      ),
      Effect.catchTag("NotFound", () => emptyList<oslogin.SshPublicKey>()),
    );

/** Find a key of `user` by its exact public key text. */
export const findKeyByText = (user: string, key: string, project?: string) =>
  listSshPublicKeys(user, project).pipe(
    Effect.map((items) =>
      items.find((item) => sameText(item.key?.trim(), key.trim())),
    ),
  );
