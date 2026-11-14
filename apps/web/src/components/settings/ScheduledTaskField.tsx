import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { threadFamilies } from "../../state/threads";
import { Label } from "../ui/label";

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

export function ScheduledTaskDestination({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
}) {
  const ref = threadId === null ? null : scopeThreadRef(environmentId, threadId);
  const shell = useThreadShell(ref);
  // The shell can omit older settled threads; their family read still carries the title.
  const family = useEnvironmentQuery(
    ref !== null && shell === null ? threadFamilies.familyAtom(environmentId, ref.threadId) : null,
  );
  const thread = shell ?? family.data?.threads.find((row) => row.id === threadId);
  return (
    <Field label="Destination">
      {ref === null ? (
        <p className="text-sm text-muted-foreground">
          Each run starts a new thread with the workspace and model below.
        </p>
      ) : (
        <div className="space-y-1 text-sm">
          <p className="wrap-anywhere">{thread?.title.trim() || `Thread ${ref.threadId}`}</p>
          <p className="text-muted-foreground">
            Each run continues this conversation, in its workspace and with its current model.
          </p>
        </div>
      )}
    </Field>
  );
}
