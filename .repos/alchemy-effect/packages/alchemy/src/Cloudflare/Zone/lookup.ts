import {
  Credentials,
  formatHeaders,
} from "@distilled.cloud/cloudflare/Credentials";
import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";

/**
 * Reference to an existing Cloudflare Zone. Accepts:
 *   - a zone id (32 hex characters),
 *   - a zone name (`example.com`), or
 *   - a `{ zoneId, name? }` object (e.g. the output of a `Zone` resource or
 *     {@link importZone}).
 */
export type Reference = string | { zoneId: string; name?: string };

export const isId = (zone: string): boolean => /^[a-f0-9]{32}$/i.test(zone);

export const matchesZoneHostname = (
  zoneName: string,
  hostname: string,
): boolean => hostname === zoneName || hostname.endsWith(`.${zoneName}`);

export const resolveZoneId = ({
  accountId,
  zone,
  hostname,
}: {
  accountId: string;
  zone: Reference | undefined;
  hostname: string;
}) =>
  Effect.gen(function* () {
    if (typeof zone === "object") return zone.zoneId;
    if (typeof zone === "string" && isId(zone)) return zone;

    const lookup = zone ?? hostname;
    for (const candidate of zoneNameCandidates(lookup)) {
      const match = yield* findZoneByName({ accountId, name: candidate });
      if (match) return match.id;
    }
    return yield* Effect.fail(
      new Error(`Cloudflare zone not found for ${lookup}`),
    );
  });

type ZoneListItem = {
  id: string;
  name: string;
  account: { id?: string | null };
};

type ZoneListResponse = {
  success: boolean;
  errors?: { message?: string }[];
  result?: ZoneListItem[];
};

export const findZoneByName = ({
  accountId,
  name,
}: {
  accountId: string;
  name: string;
}): Effect.Effect<ZoneListItem | undefined, Error, Credentials> =>
  Effect.gen(function* () {
    const credentialsEffect = yield* Credentials;
    const credentials = yield* credentialsEffect;
    const url = new URL(`${credentials.apiBaseUrl}/zones`);
    url.searchParams.set("account.id", accountId);
    url.searchParams.set("name", name);
    url.searchParams.set("per_page", "1");

    const json = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          headers: formatHeaders(credentials),
        });
        return (await response.json()) as ZoneListResponse;
      },
      catch: (cause) => new Error(`Failed to list Cloudflare zones`, { cause }),
    });

    if (!json.success) {
      return yield* Effect.fail(
        new Error(
          json.errors?.map((error) => error.message).join(", ") ??
            `Failed to list Cloudflare zones`,
        ),
      );
    }

    return json.result?.find(
      (candidate) =>
        candidate.name === name && candidate.account.id === accountId,
    );
  });

/**
 * Exhaustively enumerate every zone in an account. Used by `list()` lifecycle
 * operations on zone-scoped resources to fan out across all zones. Returns only
 * the stable `{ id, name }` pair each caller needs to drive a per-zone list.
 */
export const listAllZones = (
  accountId: string,
): Effect.Effect<
  { id: string; name: string }[],
  zones.ListZonesError,
  Credentials | HttpClient.HttpClient
> =>
  zones.listZones.pages({ account: { id: accountId } }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).flatMap((page) =>
        (page.result ?? []).map((zone) => ({ id: zone.id, name: zone.name })),
      ),
    ),
  );

const zoneNameCandidates = (hostname: string): string[] => {
  const parts = hostname.split(".");
  return parts.slice(0, -1).map((_, index) => parts.slice(index).join("."));
};
