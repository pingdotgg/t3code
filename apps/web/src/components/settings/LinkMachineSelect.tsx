import {
  ANOTHER_ADDRESS,
  type LinkableMachine,
  linkDestination,
} from "@t3tools/client-runtime/link-request";
import { T, useGT } from "gt-react";
import { useId } from "react";

import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const T3_CONNECT_NAME = "T3 Connect";

/**
 * Shown wherever a link goes to an address this app does not already have for a
 * machine, with where that address leads.
 */
export function LinkAddressWarning({ address }: { readonly address: string }) {
  return (
    <Alert variant="warning">
      <AlertTitle>
        <T>Check this address</T>
      </AlertTitle>
      <AlertDescription>
        <T>
          This app cannot confirm it is one of your machines. The pairing code you paste is sent
          there.
        </T>
        <span className="block break-all">{linkDestination(address)}</span>
      </AlertDescription>
    </Alert>
  );
}

/** Whether a machine is linked already, or how this app knows it when not connected to it. */
export function LinkMachineBadge({ machine }: { readonly machine: LinkableMachine }) {
  const gt = useGT();
  if (machine.linkedAccess !== null) {
    return (
      <Badge variant="success" size="sm">
        <T>Linked</T>
      </Badge>
    );
  }
  if (machine.connected) return null;
  return (
    <Badge variant="outline" size="sm">
      {machine.connectOnly ? T3_CONNECT_NAME : gt("Not connected")}
    </Badge>
  );
}

function MachineName({ machine }: { readonly machine: LinkableMachine }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <EnvironmentMachineIcon kind={machine.machine} className="size-4 shrink-0 opacity-80" />
      <span className="min-w-0 truncate">{machine.label}</span>
    </span>
  );
}

/** The user's other machines, including those on their T3 Connect account, then an address. */
export function LinkMachineSelect({
  machines,
  value,
  onChange,
  disabled,
}: {
  readonly machines: ReadonlyArray<LinkableMachine>;
  readonly value: string | null;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const labelId = useId();
  return (
    <div className="space-y-1.5">
      <span id={labelId} className="block text-xs font-medium text-foreground">
        <T>Machine</T>
      </span>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onChange(next as string);
        }}
      >
        <SelectTrigger aria-labelledby={labelId}>
          <SelectValue>
            {(selected: string | null) => {
              if (selected === ANOTHER_ADDRESS) return gt("Another address…");
              const machine = machines.find((candidate) => candidate.environmentId === selected);
              return machine === undefined ? (
                gt("Choose a machine")
              ) : (
                <MachineName machine={machine} />
              );
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {machines.map((machine) => (
            <SelectItem key={machine.environmentId} value={machine.environmentId} hideIndicator>
              <span className="flex min-w-0 items-center justify-between gap-3">
                <MachineName machine={machine} />
                <LinkMachineBadge machine={machine} />
              </span>
            </SelectItem>
          ))}
          <SelectItem value={ANOTHER_ADDRESS} hideIndicator>
            <T>Another address…</T>
          </SelectItem>
        </SelectPopup>
      </Select>
    </div>
  );
}
