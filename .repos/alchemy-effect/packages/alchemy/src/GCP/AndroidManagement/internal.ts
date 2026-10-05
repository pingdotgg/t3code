import * as androidmanagement from "@distilled.cloud/gcp/androidmanagement_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";

export const ENTERPRISE_PREFIX = "enterprises/";
export const MAX_DISPLAY_NAME_LENGTH = 100;
export const MAX_WEB_APP_TITLE_LENGTH = 100;
export const MAX_ADDITIONAL_DATA_LENGTH = 1024;
export const DEFAULT_DURATION = "315360000s";
export const DEFAULT_DISPLAY_MODE = "STANDALONE";
export const DEFAULT_START_URL = "https://example.com/";

export const DEFAULT_WEB_APP_ICON: androidmanagement.WebAppIcon = {
  imageData:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
};

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const normalizeName = (value: string) => value.replace(/\/+$/, "");

export const toEnterpriseName = (value: string) => {
  const trimmed = normalizeName(value);
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith(ENTERPRISE_PREFIX)) return trimmed;
  return `${ENTERPRISE_PREFIX}${trimmed}`;
};

export const toEnrollmentTokenName = (parent: string, tokenId?: string) => {
  if (tokenId !== undefined && tokenId.includes("/enrollmentTokens/")) {
    return normalizeName(tokenId);
  }
  if (tokenId !== undefined && tokenId.length > 0 && parent.length > 0) {
    return `${toEnterpriseName(parent)}/enrollmentTokens/${lastSegment(tokenId)}`;
  }
  return "";
};

export const toWebAppName = (parent: string, webAppId?: string) => {
  if (webAppId !== undefined && webAppId.includes("/webApps/")) {
    return normalizeName(webAppId);
  }
  if (webAppId !== undefined && webAppId.length > 0 && parent.length > 0) {
    return `${toEnterpriseName(parent)}/webApps/${lastSegment(webAppId)}`;
  }
  return "";
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBoolean = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left ?? false) === (right ?? false);

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  jsonEqual(
    [...(left ?? [])].slice().sort(),
    [...(right ?? [])].slice().sort(),
  );

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  if (input.extra === true) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousParent !== undefined &&
    input.nextParent !== undefined &&
    toEnterpriseName(input.previousParent) !==
      toEnterpriseName(input.nextParent)
  ) {
    return { action: "replace" as const, deleteFirst: true };
  }
  return undefined;
};

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    return yield* createPhysicalName({
      id,
      maxLength: Math.min(40, maxLength),
      lowercase: true,
    });
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const getEnterprise = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : androidmanagement
        .getEnterprises({ name: toEnterpriseName(name) })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getEnrollmentToken = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : androidmanagement
        .getEnterprisesEnrollmentTokens({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getWebApp = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : androidmanagement
        .getEnterprisesWebApps({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listEnterprisesAt = (projectId: string) =>
  projectId.length === 0
    ? emptyList<androidmanagement.Enterprise>()
    : collectPages(
        androidmanagement.listEnterprises.pages({
          projectId,
          view: "BASIC",
          pageSize: 100,
        }),
        (page) => page.enterprises,
      ).pipe(
        // A missing parent has no children.
        Effect.catchTag("NotFound", () =>
          emptyList<androidmanagement.Enterprise>(),
        ),
      );

export const listWebAppsAt = (parent: string) =>
  parent.length === 0
    ? emptyList<androidmanagement.WebApp>()
    : collectPages(
        androidmanagement.listEnterprisesWebApps.pages({
          parent: toEnterpriseName(parent),
          pageSize: 100,
        }),
        (page) => page.webApps,
      ).pipe(
        // A missing parent has no children.
        Effect.catchTag("NotFound", () =>
          emptyList<androidmanagement.WebApp>(),
        ),
      );

const hydrateEnterprise = (enterprise: androidmanagement.Enterprise) =>
  Effect.gen(function* () {
    if (
      enterprise.enterpriseDisplayName !== undefined &&
      enterprise.enterpriseDisplayName.length > 0
    ) {
      return enterprise;
    }
    const name = enterprise.name ?? "";
    if (name.length === 0) return enterprise;
    return (yield* getEnterprise(name)) ?? enterprise;
  });

/** Find an enterprise of `projectId` by its display name. */
export const findEnterpriseByDisplayName = (
  projectId: string,
  displayName: string,
) =>
  Effect.gen(function* () {
    const listed = yield* listEnterprisesAt(projectId);
    for (const enterprise of listed) {
      const hydrated = yield* hydrateEnterprise(enterprise);
      if (hydrated.enterpriseDisplayName === displayName) return hydrated;
    }
    return undefined;
  });

/** Find a web app of `parent` by its title. */
export const findWebAppByTitle = (parent: string, title: string) =>
  listWebAppsAt(parent).pipe(
    Effect.map((apps) => apps.find((app) => app.title === title)),
  );

export const defaultWebAppIcons = (
  icons: readonly androidmanagement.WebAppIcon[] | undefined,
): androidmanagement.WebAppIcon[] =>
  icons && icons.length > 0 ? [...icons] : [DEFAULT_WEB_APP_ICON];
