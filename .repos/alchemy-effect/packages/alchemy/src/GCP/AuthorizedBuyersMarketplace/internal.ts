import * as marketplace from "@distilled.cloud/gcp/authorizedbuyersmarketplace_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";

export const PROBE_PARENT = "buyers/1/clients/1";
export const PROBE_NAME = `${PROBE_PARENT}/users/0`;

export type ClientUserState = marketplace.ClientUserStateEnum;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeResourceName = (value: string) =>
  value.replace(/\/+$/, "").trim();

export const expandParent = (value: string) => {
  const trimmed = normalizeResourceName(value);
  if (trimmed.length === 0) return trimmed;
  if (trimmed.includes("/clients/")) {
    return trimmed.startsWith("buyers/") ? trimmed : `buyers/${trimmed}`;
  }
  return trimmed;
};

export const parentOfName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const usersIndex = parts.lastIndexOf("users");
  if (usersIndex > 0) return parts.slice(0, usersIndex).join("/");
  const clientUsersIndex = parts.lastIndexOf("clientUsers");
  if (clientUsersIndex > 0) return parts.slice(0, clientUsersIndex).join("/");
  return "";
};

export const resourceName = (parent: string, userId: string) =>
  `${expandParent(parent)}/users/${userId}`;

export const userIdOf = (name: string) => lastSegment(name);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const normalizeEmail = (email: string | undefined) =>
  (email ?? "").trim().toLowerCase();

export const replaceOnIdentity = (input: {
  previousParent?: string;
  nextParent: string;
  previousEmail?: string;
  nextEmail?: string;
  previousUserId?: string;
  nextUserId?: string;
}) => {
  if (
    input.previousParent !== undefined &&
    input.previousParent.length > 0 &&
    input.previousParent !== input.nextParent
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousEmail !== undefined &&
    input.nextEmail !== undefined &&
    normalizeEmail(input.previousEmail) !== normalizeEmail(input.nextEmail)
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousUserId !== undefined &&
    input.nextUserId !== undefined &&
    input.previousUserId !== input.nextUserId
  ) {
    return { action: "replace" as const, deleteFirst: true };
  }
  return undefined;
};

export const toEmail = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 32,
      lowercase: true,
    });
    const local = generated.replace(/[^a-z0-9]/g, "").slice(0, 32) || "alchemy";
    return `${local}@example.com`;
  });

export type ClientUserAttrs = {
  name: string;
  userId: string;
  parent: string;
  project: string;
  email: string;
  state: string | undefined;
};

export const toAttrs = (
  user: marketplace.ClientUser,
  parent: string,
  project: string,
): ClientUserAttrs => {
  const name = user.name ?? "";
  return {
    name,
    userId: userIdOf(name),
    parent: parentOfName(name) || parent,
    project,
    email: user.email ?? "",
    state: user.state,
  };
};

/** Email is unique per client, so it identifies the user. */
export const findUserByEmail = (
  users: readonly marketplace.ClientUser[],
  email: string,
) => users.find((user) => normalizeEmail(user.email) === normalizeEmail(email));

export const listUsers = (parent: string) =>
  marketplace.listBuyersClientsUsers.pages({ parent, pageSize: 200 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.clientUsers ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
