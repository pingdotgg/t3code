import * as gmailpostmastertools from "@distilled.cloud/gcp/gmailpostmastertools_v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";

export const DEFAULT_DOMAIN_SUFFIX = "example.com";
export const DEFAULT_EMAIL_DOMAIN = "example.com";
export const DEFAULT_PERMISSION = "READER";
export const DOMAIN_PREFIX = "domains/";
export const USERS_SEGMENT = "/users/";

const emptyList = <A>() => Effect.succeed([] as A[]);

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const normalize = (value: string | undefined) =>
  (value ?? "").trim().toLowerCase();

export const toDomainName = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith(DOMAIN_PREFIX)) return trimmed;
  return `${DOMAIN_PREFIX}${trimmed}`;
};

export const domainIdOf = (value: string | undefined) => {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith(DOMAIN_PREFIX)) {
    return trimmed.slice(DOMAIN_PREFIX.length).split("/")[0] ?? trimmed;
  }
  return trimmed;
};

export const userIdOf = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const usersAt = value.indexOf(USERS_SEGMENT);
  if (usersAt >= 0) return value.slice(usersAt + USERS_SEGMENT.length);
  if (value.startsWith("users/")) return value.slice("users/".length);
  return lastSegment(value);
};

export const toUserName = (parent: string, userId: string) => {
  if (userId.startsWith(DOMAIN_PREFIX) && userId.includes(USERS_SEGMENT)) {
    return userId;
  }
  const domain = toDomainName(parent);
  const user = userId.startsWith("users/")
    ? userId.slice("users/".length)
    : userIdOf(userId) || userId;
  if (domain.length === 0 || user.length === 0) return "";
  return `${domain}${USERS_SEGMENT}${user}`;
};

export const parentOfUserName = (name: string) => {
  const usersAt = name.indexOf(USERS_SEGMENT);
  if (usersAt > 0) return name.slice(0, usersAt);
  return "";
};

export const userEmailOf = (user: gmailpostmastertools.User) =>
  user.user ?? userIdOf(user.name);

export const fullUserName = (
  parent: string,
  user: gmailpostmastertools.User,
) => {
  const name = user.name ?? "";
  if (name.startsWith(DOMAIN_PREFIX) && name.includes(USERS_SEGMENT)) {
    return name;
  }
  return toUserName(parent, userEmailOf(user) || name);
};

const dnsLabel = (value: string, maxLength: number) => {
  let label = /^[a-z]/.test(value) ? value : `a${value}`;
  label = label.replace(/^-+|-+$/g, "");
  if (!label.startsWith("alchemy-")) {
    label = `alchemy-${label}`;
  }
  return label.slice(0, maxLength).replace(/-+$/g, "");
};

export const isAlchemyDomain = (name: string | undefined) => {
  const id = domainIdOf(name).toLowerCase();
  const first = id.split(".")[0] ?? "";
  return first.startsWith("alchemy-") || id.includes("alchemy-");
};

export const isAlchemyEmail = (email: string | undefined) => {
  const value = normalize(email);
  const local = value.split("@")[0] ?? "";
  return local.startsWith("alchemy-") || local.includes("+alchemy-");
};

export const isPatchablePermission = (permission: string | undefined) =>
  permission === "READER" || permission === "ADMIN";

export const toGeneratedDomainId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.toLowerCase();
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.toLowerCase();
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength: 48,
      lowercase: true,
    });
    const label = dnsLabel(generated, 63);
    return `${label}.${DEFAULT_DOMAIN_SUFFIX}`;
  });

export const toGeneratedUserId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.toLowerCase();
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.toLowerCase();
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
    const local = dnsLabel(generated, 64);
    return `${local}@${DEFAULT_EMAIL_DOMAIN}`;
  });

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
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.void,
    ),
  );

export const getDomain = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        gmailpostmastertools.getDomains({ name: toDomainName(name) }),
      );

export const getUser = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(gmailpostmastertools.getDomainsUsers({ name }));

export const listDomains = () =>
  gmailpostmastertools.listDomains.pages({ pageSize: 200 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.domains ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => emptyList<gmailpostmastertools.Domain>()),
  );

export const listUsers = (parent: string) =>
  parent.length === 0
    ? emptyList<gmailpostmastertools.User>()
    : gmailpostmastertools.listDomainsUsers
        .pages({ parent: toDomainName(parent), pageSize: 200 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.users ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<gmailpostmastertools.User>(),
          ),
        );

export const listOwnedDomains = () =>
  listDomains().pipe(
    Effect.map((domains) =>
      domains.filter((domain) => isAlchemyDomain(domain.name)),
    ),
  );

export const listOwnedUsers = () =>
  Effect.gen(function* () {
    const domains = yield* listDomains();
    const users = yield* Effect.forEach(
      domains.filter((domain) => (domain.name ?? "").length > 0),
      (domain) => listUsers(domain.name ?? ""),
      { concurrency: 4 },
    );
    return users.flat().filter((user) => isAlchemyEmail(userEmailOf(user)));
  });

export const findUser = (parent: string, userId: string, name: string) =>
  Effect.gen(function* () {
    const existing = yield* getUser(name || toUserName(parent, userId));
    if (existing !== undefined) return existing;
    if (userId.length === 0 && name.length === 0) return undefined;
    const users = yield* listUsers(parent);
    const wanted = normalize(userId || userIdOf(name));
    return users.find(
      (user) =>
        normalize(userEmailOf(user)) === wanted ||
        normalize(user.name) === normalize(name),
    );
  });
