import type { EnvironmentId, PeerLinkSummary } from "@t3tools/contracts";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
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
) {
  if (links === null)
    return {
      label: "Return unchecked",
      detail: "Expand to check the return link.",
      warning: false,
    };
  const back = links.find((link) => link.environmentId === sourceId);
  if (!back) return { label: "One-way", detail: "No return link was found.", warning: false };
  const health = peerLinkHealth(back, now);
  if (health.kind === "expired")
    return { label: "Return expired", detail: "The return link has expired.", warning: true };
  return {
    label: "Two-way",
    detail: `Both devices have links. Return permission: ${back.access === "read-only" ? "Read only" : runtimeModeConfig[back.access].label}.${health.kind !== "reachable" ? " The return link needs attention." : ""}`,
    warning: health.kind !== "reachable",
  };
}

export function linkedEnvironmentStatus(link: PeerLinkSummary, now: DateTime.Utc) {
  const health = peerLinkHealth(link, now);
  return {
    attention: health.kind !== "reachable" || health.expiresInDays !== null,
    label:
      health.kind === "reachable"
        ? health.expiresInDays === null
          ? "Ready"
          : `Expires in ${health.expiresInDays}d`
        : health.kind === "expired"
          ? "Expired"
          : health.kind === "failing"
            ? "Last call failed"
            : "Unreachable",
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
