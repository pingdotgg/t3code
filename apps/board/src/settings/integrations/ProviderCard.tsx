import type { SourceControlProviderDiscoveryItem } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Cloud, Github, Gitlab } from "lucide-react";

import { IntegrationCard, type IntegrationStatus } from "./IntegrationCard";
import { IntegrationDetails } from "./IntegrationDetails";

const ICON = "size-5";

function statusOf(item: SourceControlProviderDiscoveryItem) {
  if (item.status === "missing") return { label: "Not installed", tone: "attention" } as const;
  switch (item.auth.status) {
    case "authenticated":
      return { label: "Connected", tone: "connected" } as const;
    case "unauthenticated":
      return { label: "Not authenticated", tone: "attention" } as const;
    case "unknown":
      return { label: "Status unknown", tone: "neutral" } as const;
  }
}

const signedIn = (item: SourceControlProviderDiscoveryItem): string => {
  const account = Option.getOrNull(item.auth.account);
  const host = Option.getOrNull(item.auth.host);
  return account === null || item.status === "missing"
    ? ""
    : ` Signed in as ${account}${host === null ? "" : ` on ${host}`}.`;
};

/** The engine signs in through the host's own CLI, so the card shows the state and offers no button of its own. */
export function ProviderCard({
  item,
  purpose,
}: {
  item: SourceControlProviderDiscoveryItem;
  purpose: "source-control" | "tracker";
}) {
  const status: IntegrationStatus = statusOf(item);
  const detail = Option.getOrNull(item.detail) ?? Option.getOrNull(item.auth.detail);
  const guidance = item.status === "missing" ? item.installHint : detail;
  const what =
    purpose === "tracker"
      ? `Browse ${item.label} issues and start boards from them.`
      : `Pull requests, checks and review status${item.executable === undefined ? "" : ` through the ${item.executable} CLI`}.`;
  return (
    <IntegrationCard
      id={purpose === "tracker" ? `${item.kind}-issues` : item.kind}
      icon={
        item.kind === "github" ? (
          <Github className={ICON} aria-hidden />
        ) : item.kind === "gitlab" ? (
          <Gitlab className={ICON} aria-hidden />
        ) : (
          <Cloud className={ICON} aria-hidden />
        )
      }
      name={item.label}
      description={`${what}${signedIn(item)}`}
      status={status}
    >
      {status.tone !== "connected" && guidance !== null && (
        <IntegrationDetails>
          <p className="text-xs text-muted">{guidance}</p>
        </IntegrationDetails>
      )}
    </IntegrationCard>
  );
}
