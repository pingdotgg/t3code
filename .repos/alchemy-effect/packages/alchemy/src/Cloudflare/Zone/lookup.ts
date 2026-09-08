import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
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

export const findZoneByName = ({
  accountId,
  name,
}: {
  accountId: string;
  name: string;
}): Effect.Effect<
  ZoneListItem | undefined,
  zones.ListZonesError,
  Credentials | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    // Distilled `listZones` rides `Retry.makeDefault` (5xx / throttling).
    // The previous raw `fetch` failed the first time Cloudflare answered
    // `{ success: false, errors: [{ message: "unhandled server error" }] }`.
    const page = yield* zones.listZones({
      account: { id: accountId },
      name,
      perPage: 1,
    });
    const match = (page.result ?? []).find(
      (candidate) =>
        candidate.name === name && candidate.account.id === accountId,
    );
    if (match === undefined) return undefined;
    return {
      id: match.id,
      name: match.name,
      account: { id: match.account.id },
    };
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

/** Hostname plus each parent label, longest first — used to infer a zone. */
export const zoneNameCandidates = (hostname: string): string[] => {
  const parts = hostname.split(".");
  return parts.slice(0, -1).map((_, index) => parts.slice(index).join("."));
};
