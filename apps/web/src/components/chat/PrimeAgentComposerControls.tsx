import type { ProviderDriverKind } from "@t3tools/contracts";
import { msg, T, useGT } from "gt-react";
import {
  BotIcon,
  CloudAlertIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  TargetIcon,
} from "lucide-react";
import { useState } from "react";

import { m, type MessageResolver } from "~/i18n/messages";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import {
  applyPrimeAgentCommandToPrompt,
  DEFAULT_AUTONOMOUS_MAX_TOKENS,
  DEFAULT_AUTONOMOUS_MAX_TURNS,
  shouldWarnPrimeAgentLocalHost,
} from "./PrimeAgentComposerControls.logic";

export function PrimeAgentComposerControls(props: {
  readonly size: ComposerControlSize;
  readonly isCloudSandbox: boolean;
  readonly hidden?: boolean;
  readonly onPromptEdit: (edit: (prompt: string) => string) => void;
}) {
  const gt = useGT();
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const [maxTurns, setMaxTurns] = useState(String(DEFAULT_AUTONOMOUS_MAX_TURNS));
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_AUTONOMOUS_MAX_TOKENS));

  const applyCommand = (kind: "goal" | "autonomous" | "refine") => {
    props.onPromptEdit((prompt) =>
      applyPrimeAgentCommandToPrompt(
        prompt,
        kind,
        kind === "autonomous" ? { maxTurns, maxTokens } : undefined,
      ),
    );
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ComposerControl
            size={props.size}
            aria-label={gt("Prime Agent controls")}
            data-prime-agent-controls="true"
          />
        }
      >
        <ComposerControlIcon icon={SlidersHorizontalIcon} size={props.size} />
        <span data-composer-control-label>
          <T>Prime</T>
        </span>
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        width="md"
        padding="compact"
        {...composerFloatingLayerProps}
      >
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-xs text-foreground">
              <T>Prime Agent commands</T>
            </span>
            <Badge variant={props.isCloudSandbox ? "secondary" : "outline"} size="sm">
              {props.isCloudSandbox ? gt("Cloud sandbox") : gt("Local host")}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <Button type="button" variant="outline" size="xs" onClick={() => applyCommand("goal")}>
              <TargetIcon />
              <span>/goal</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => applyCommand("refine")}
            >
              <RefreshCwIcon />
              <span>/refine</span>
            </Button>
          </div>

          <div className="grid gap-2 border-t border-border/60 pt-2">
            <div className="font-medium text-xs text-muted-foreground">
              <T>Autonomous budget caps</T>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-xs text-muted-foreground">
                <span>
                  <T>Max turns</T>
                </span>
                <Input
                  size="sm"
                  inputMode="numeric"
                  value={maxTurns}
                  onChange={(event) => setMaxTurns(event.target.value)}
                  placeholder="25"
                  aria-label={gt("Autonomous max turns")}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                <span>
                  <T>Max tokens</T>
                </span>
                <Input
                  size="sm"
                  inputMode="numeric"
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(event.target.value)}
                  placeholder="200000"
                  aria-label={gt("Autonomous max tokens")}
                />
              </label>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => applyCommand("autonomous")}
            >
              <BotIcon />
              <span>
                <T>Insert /autonomous with budget</T>
              </span>
            </Button>
          </div>

          <p className="text-2xs text-muted-foreground leading-snug">
            <T>
              Adjust Thinking, Provider, and RLM depth (0 disables rlm.spawn) in the model menu.
              Changes restart Prime Agent and reattach via --resume.
            </T>
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

const LOCAL_HOST_WARNING_TITLE = msg("Prime Agent is running on your local host");
const LOCAL_HOST_WARNING_DESCRIPTION = msg(
  "Prime Agent runs an IPython REPL and recursive rlm.spawn subagents directly on this machine. Switch to a cloud sandbox or set RLM depth to 0 for stricter isolation.",
);
const LOCAL_HOST_WARNING_DISMISS = msg("Dismiss local host warning");

export function buildPrimeAgentHostWarningBanner(input: {
  readonly provider: ProviderDriverKind;
  readonly isCloudSandbox: boolean;
  readonly dismissed: boolean;
  readonly onDismiss: () => void;
  readonly resolve?: MessageResolver;
}): ComposerBannerStackItem | null {
  if (
    input.dismissed ||
    !shouldWarnPrimeAgentLocalHost({
      provider: input.provider,
      isCloudSandbox: input.isCloudSandbox,
    })
  ) {
    return null;
  }
  const resolve = input.resolve ?? m;
  return {
    id: "prime-agent-local-host-warning",
    group: "environment",
    variant: "warning",
    icon: <CloudAlertIcon />,
    title: resolve(LOCAL_HOST_WARNING_TITLE),
    description: resolve(LOCAL_HOST_WARNING_DESCRIPTION),
    dismissLabel: resolve(LOCAL_HOST_WARNING_DISMISS),
    onDismiss: input.onDismiss,
  };
}
