import type { EnvironmentId, PeerLinkSummary } from "@t3tools/contracts";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import { msg } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import type * as DateTime from "effect/DateTime";

export function linkRenewalUrls(
  knownUrls: ReadonlyArray<string>,
  savedUrls: ReadonlyArray<string>,
) {
  return [...new Set([...knownUrls, ...savedUrls])];
}

export function linkedEnvironmentList(
  links: ReadonlyArray<PeerLinkSummary>,
  search: string,
  attentionOnly: boolean,
  now: DateTime.Utc,
) {
  const query = search.trim().toLocaleLowerCase();
  return {
    showFilters: links.length > 2 || query.length > 0 || attentionOnly,
    visible: links.filter(
      (link) =>
        link.label.toLocaleLowerCase().includes(query) &&
        (!attentionOnly || linkedEnvironmentStatus(link, now).attention),
    ),
  };
}

export function returnLinkStatus(
  sourceId: EnvironmentId,
  links: ReadonlyArray<PeerLinkSummary> | null,
  now: DateTime.Utc,
  resolve: MessageResolver = m,
) {
  if (links === null)
    return {
      label: resolve(msg("Return unchecked")),
      detail: resolve(msg("Expand to check the return link.")),
      warning: false,
    };
  const back = links.find((link) => link.environmentId === sourceId);
  if (!back)
    return {
      label: resolve(msg("One-way")),
      detail: resolve(msg("No return link was found.")),
      warning: false,
    };
  const health = peerLinkHealth(back, now);
  if (health.kind === "expired")
    return {
      label: resolve(msg("Return expired")),
      detail: resolve(msg("The return link has expired.")),
      warning: true,
    };
  const detail = resolve(msg("Both devices have links. Return permission: {permission}."), {
    permission:
      back.access === "read-only"
        ? resolve(msg("Read only"))
        : resolve(runtimeModeConfig[back.access].label),
  });
  return {
    label: resolve(msg("Two-way")),
    detail:
      health.kind === "reachable"
        ? detail
        : `${detail} ${resolve(msg("The return link needs attention."))}`,
    warning: health.kind !== "reachable",
  };
}

export function linkedEnvironmentStatus(
  link: PeerLinkSummary,
  now: DateTime.Utc,
  resolve: MessageResolver = m,
) {
  const health = peerLinkHealth(link, now);
  return {
    attention: health.kind !== "reachable" || health.expiresInDays !== null,
    label:
      health.kind === "reachable"
        ? health.expiresInDays === null
          ? resolve(msg("Ready"))
          : resolve(msg("Expires in {days}d"), { days: health.expiresInDays })
        : health.kind === "expired"
          ? resolve(msg("Expired"))
          : health.kind === "failing"
            ? resolve(msg("Last call failed"))
            : resolve(msg("Unreachable")),
    detail: health.kind === "failing" || health.kind === "unreachable" ? health.detail : null,
    dot:
      health.kind === "reachable"
        ? health.expiresInDays === null
          ? "bg-success"
          : "bg-warning"
        : health.kind === "expired" || health.kind === "failing"
          ? "bg-destructive"
          : "bg-muted-foreground/40",
  };
}
