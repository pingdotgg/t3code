import {
  formatProviderSubagentStatus,
  type ProviderSubagentStatus,
} from "@t3tools/client-runtime/state/thread-execution";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { ArrowUpLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

import { tickTextContent } from "~/lib/tickTextContent";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../ui/button";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  ReadOnlyComposerBar,
  ReadOnlyComposerLead,
  ReadOnlyComposerStatus,
} from "./ReadOnlyComposerBar";

export function ProviderSubagentBar(props: {
  readonly provider: ProviderInstanceEntry | null;
  readonly showInstanceBadge: boolean;
  readonly modelLabel: string;
  readonly effortLabel: string | null;
  readonly status: ProviderSubagentStatus | null;
  readonly onOpenParent: (() => void) | null;
  readonly actions?: ReactNode;
}) {
  const { status } = props;
  const gt = useGT();
  const messages = useMessages();
  const live = status !== null && isOrchestrationV2WorkActive(status.status);
  const modelDescription =
    props.effortLabel === null ? props.modelLabel : `${props.modelLabel}, ${props.effortLabel}`;
  const announcement = formatProviderSubagentStatus(
    status === null ? null : { ...status, startedAt: null },
    0,
    messages,
  );

  return (
    <ReadOnlyComposerBar
      actions={
        <>
          <span role="status" className="sr-only">
            {gt("{model} subagent: {status}", { model: modelDescription, status: announcement })}
          </span>
          <span className="shrink-0 text-muted-foreground @max-[640px]/composer-surface:sr-only">
            <T>Runs on its own</T>
          </span>
          {props.actions}
          {props.onOpenParent ? (
            <Button size="sm" variant="ghost" onClick={props.onOpenParent}>
              <ArrowUpLeftIcon />
              <span className="@max-[320px]/composer-surface:sr-only">
                <T>Open parent</T>
              </span>
            </Button>
          ) : null}
        </>
      }
    >
      <ReadOnlyComposerLead>
        {props.provider ? (
          <ProviderInstanceIcon
            driverKind={props.provider.driverKind}
            displayName={props.provider.displayName}
            accentColor={props.provider.accentColor}
            acpRegistryAgentId={props.provider.acpRegistryAgentId}
            acpRegistryIconUrl={props.provider.acpRegistryIconUrl}
            showBadge={props.showInstanceBadge}
            className="size-4 shrink-0"
            iconClassName="size-4"
            badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"
          />
        ) : null}
        <span className="min-w-0 truncate font-medium text-foreground">{props.modelLabel}</span>
        {props.effortLabel === null ? null : (
          <span className="shrink-0 text-muted-foreground">{props.effortLabel}</span>
        )}
      </ReadOnlyComposerLead>
      <ReadOnlyComposerStatus
        ref={tickTextContent(
          (nowMs) => formatProviderSubagentStatus(status, nowMs, messages),
          live,
        )}
        aria-hidden
      />
    </ReadOnlyComposerBar>
  );
}
