import { useAtomValue } from "@effect/atom-react";
import type { HandoffEndpoints } from "@t3tools/client-runtime/handoff";

import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import type { EnvironmentId } from "@t3tools/contracts";
import { InlineButton } from "../ui/button";
import { getTriggerDisplayModelName } from "./providerIconUtils";

export function SideChatContextLine({
  environmentId,
  title,
  open,
  handoff,
}: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly open?: (() => void) | undefined;
  readonly handoff: HandoffEndpoints | null;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const modelLabel = (endpoint: HandoffEndpoints["from"][number]) => {
    const provider = providers.find((candidate) => candidate.instanceId === endpoint.instanceId);
    const model = provider?.models.find((candidate) => candidate.slug === endpoint.model);
    return model
      ? getTriggerDisplayModelName(model, provider?.driver)
      : (endpoint.model ?? provider?.displayName ?? endpoint.instanceId);
  };
  const modelChanged =
    handoff !== null && handoff.from.some((from) => from.model !== handoff.to.model);
  const change = modelChanged
    ? `${handoff.from.map(modelLabel).join(", ")} → ${modelLabel(handoff.to)}`
    : null;
  return (
    <div
      className="flex min-w-0 items-center gap-1 py-2 text-meta text-muted-foreground"
      data-side-chat-context
    >
      <span className="shrink-0">Context from</span>
      <span className="min-w-0 truncate">
        {open ? (
          <InlineButton tone="muted" aria-label="Open parent thread" onClick={open}>
            {title}
          </InlineButton>
        ) : (
          title
        )}
      </span>
      {change ? (
        <span className="ml-1 min-w-0 truncate border-l border-border pl-2">{change}</span>
      ) : null}
    </div>
  );
}
