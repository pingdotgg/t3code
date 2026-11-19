import { type EnvironmentContextRecord, resolveEnvironmentMachineKind } from "@t3tools/contracts";

import { useGT } from "gt-react";

import { useEnvironment } from "~/state/environments";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { APP_NAME } from "@t3tools/shared/branding";

/**
 * Inline chip for a mentioned machine, in the composer and in sent messages. Prefers the
 * name this client knows the machine by, and draws it with its machine icon.
 */
export function EnvironmentContextChip(props: {
  record: Pick<EnvironmentContextRecord, "environmentId" | "label">;
  copyMarkdown?: string;
}) {
  const gt = useGT();
  const environment = useEnvironment(props.record.environmentId);
  const label = environment?.label.trim() || props.record.label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="environment"
            tabIndex={0}
            aria-label={gt("Machine, {label}", { label })}
            data-markdown-copy={props.copyMarkdown}
          >
            <EnvironmentMachineIcon
              kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
            />
            <ContextChipLabel>{label}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        {environment ? `${APP_NAME} environment` : "Machine not in this app"}
      </TooltipPopup>
    </Tooltip>
  );
}
