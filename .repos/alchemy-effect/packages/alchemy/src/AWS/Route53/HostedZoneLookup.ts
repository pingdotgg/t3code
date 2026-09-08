import * as route53 from "@distilled.cloud/aws/route-53";
import * as Effect from "effect/Effect";

/**
 * Find the most specific PUBLIC Route 53 hosted zone containing
 * `domainName`, walking up its labels (`svc.api.example.com` →
 * `api.example.com` → `example.com`). Wildcard labels (`*`) never name a
 * zone, so they fall through to the parent naturally. Returns the bare
 * zone id (no `/hostedzone/` prefix), or `undefined` when no public zone
 * matches.
 *
 * Shared by every provider that infers a hosted zone from a hostname
 * (Route 53 Record/Records, ACM Certificate validation, ECS Service DNS).
 */
export const findPublicHostedZoneId = Effect.fn("findPublicHostedZoneId")(
  function* (domainName: string) {
    const labels = domainName
      .replace(/\.$/, "")
      .split(".")
      .filter((label) => label.length > 0);
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = `${labels.slice(i).join(".")}.`;
      const listed = yield* route53.listHostedZonesByName({
        DNSName: candidate,
        MaxItems: 1,
      });
      const zone = listed.HostedZones?.[0];
      if (
        zone?.Id !== undefined &&
        zone.Name === candidate &&
        zone.Config?.PrivateZone !== true
      ) {
        return zone.Id.replace(/^\/hostedzone\//, "");
      }
    }
    return undefined;
  },
);

/**
 * Resolve the hosted zone for `domainName`: the explicit id when given,
 * otherwise the most specific public zone in the account (see
 * {@link findPublicHostedZoneId}). Fails with an actionable error when
 * neither yields a zone.
 */
export const resolveHostedZoneId = Effect.fn("resolveHostedZoneId")(function* (
  hostedZoneId: string | undefined,
  domainName: string,
) {
  if (hostedZoneId !== undefined) {
    return hostedZoneId;
  }
  const inferred = yield* findPublicHostedZoneId(domainName);
  if (inferred === undefined) {
    return yield* Effect.fail(
      new Error(
        `No public Route 53 hosted zone in this account contains "${domainName}" — ` +
          `create the zone first or pass "hostedZoneId" explicitly.`,
      ),
    );
  }
  return inferred;
});
