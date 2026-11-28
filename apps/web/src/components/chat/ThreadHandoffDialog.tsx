import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentMachines } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { threadHandoffDialogThreadAtom, threadHandoffEnvironment } from "~/state/threadHandoff";
import { useAtomCommand } from "~/state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function ThreadHandoffDialogHost() {
  const threadRef = useAtomValue(threadHandoffDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <ThreadHandoffDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(threadHandoffDialogThreadAtom, null)}
    />
  );
}

function ThreadHandoffDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const machines = useEnvironmentMachines();
  const targets = useEnvironmentQuery(
    threadHandoffEnvironment.options({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const start = useAtomCommand(threadHandoffEnvironment.start, { reportFailure: false });
  const [picked, setPicked] = useState<EnvironmentId | null>(null);
  const options = targets.data?.options ?? [];
  const movable = options.filter((option) => option.reason === null);
  const chosen =
    movable.find((option) => option.environmentId === picked) ??
    (movable.length === 1 ? movable[0] : undefined);

  // The move outlasts the dialog: the thread's own notice shows how it goes.
  const move = () => {
    if (chosen === undefined) return;
    onClose();
    void start({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, environmentId: chosen.environmentId },
    }).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not move the thread to {machine}", { machine: chosen.label }),
          ...(error instanceof Error ? { description: error.message } : {}),
        }),
      );
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>Continue on another machine</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              The thread moves with its conversation and its code, including commits you have not
              pushed and uncommitted changes. This copy becomes read-only.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {targets.data === null && targets.error === null ? (
            <p className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner size="sm" />
              <T>Asking linked machines…</T>
            </p>
          ) : targets.data === null ? (
            <p role="alert" className="text-destructive text-sm">
              {targets.error}
            </p>
          ) : options.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {gt("This machine has no linked machines.")}{" "}
              <Link to="/settings/connections" className="underline" onClick={onClose}>
                {gt("Link one in Settings")}
              </Link>
            </p>
          ) : (
            <RadioGroup
              aria-label={gt("Machine to continue on")}
              value={chosen?.environmentId ?? ""}
              onValueChange={(value) => setPicked(value as EnvironmentId)}
            >
              {options.map((option) => (
                <label
                  key={option.environmentId}
                  className="flex items-start gap-2.5 text-sm has-data-disabled:text-muted-foreground"
                >
                  <Radio
                    className="mt-0.5"
                    value={option.environmentId}
                    disabled={option.reason !== null}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1.5 font-medium">
                      <EnvironmentMachineIcon
                        kind={machines.get(option.environmentId) ?? "server"}
                        className="size-3.5 shrink-0"
                      />
                      <span className="truncate">
                        <Var>{option.label}</Var>
                      </span>
                    </span>
                    {option.reason === null ? null : (
                      <span className="text-muted-foreground text-xs">{option.reason}</span>
                    )}
                  </span>
                </label>
              ))}
            </RadioGroup>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button size="sm" onClick={move} disabled={chosen === undefined}>
            {chosen === undefined
              ? gt("Move thread")
              : gt("Move to {machine}", { machine: chosen.label })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
