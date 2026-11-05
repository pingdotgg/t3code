import { t } from "@palamedes/core/macro";
import { Trans } from "@palamedes/react/macro";
import type {
  EnvironmentId,
  OrchestrationV2GetNativeChildWorkResult,
  OrchestrationV2NativeChildStep,
  OrchestrationV2NativeChildWork,
  ThreadId,
} from "@t3tools/contracts";
import { ListTreeIcon } from "lucide-react";
import { useState } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
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

const stepLabel = (type: string) => {
  const words = type.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Read-only view of what a provider-native subagent's children did. Loads only while open. */
export function NativeChildWorkDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <ListTreeIcon />
        <span className="@max-[420px]/composer-surface:sr-only">
          <Trans>Subagent work</Trans>
        </span>
      </Button>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <Trans>Subagent work</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Read only. These subagents cannot take messages.</Trans>
          </DialogDescription>
        </DialogHeader>
        {open ? <NativeChildWorkContent {...props} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function NativeChildWorkContent(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = useEnvironmentQuery<OrchestrationV2GetNativeChildWorkResult, unknown>(
    orchestrationEnvironment.nativeChildWork({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const children = query.data?.children;
  return (
    <>
      <DialogPanel>
        {query.error !== null ? (
          <p className="text-sm text-destructive-foreground">{query.error}</p>
        ) : children === undefined ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : children.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>The provider has no record of which subagents this call started.</Trans>
          </p>
        ) : (
          children.map((child) => <NativeChild key={child.conversationId} child={child} />)
        )}
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button size="sm" variant="outline" disabled={query.isPending} onClick={query.refresh}>
          <Trans>Refresh</Trans>
        </Button>
      </DialogFooter>
    </>
  );
}

function NativeChild(props: { readonly child: OrchestrationV2NativeChildWork }) {
  const { child } = props;
  return (
    <section
      aria-label={child.role || t({ message: "Subagent" })}
      className="flex min-w-0 flex-col gap-2"
    >
      <h3 className="text-sm font-medium text-foreground">
        {child.role || <Trans>Subagent</Trans>}
      </h3>
      <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
        {child.prompt}
      </p>
      {child.truncated ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Earlier steps are not shown.</Trans>
        </p>
      ) : null}
      {child.steps === null ? (
        <p className="text-xs text-muted-foreground">
          <Trans>No transcript yet.</Trans>
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 border-s ps-3">
          {child.steps.map((step) => (
            <NativeChildStep key={step.index} step={step} />
          ))}
        </ol>
      )}
    </section>
  );
}

function NativeChildStep(props: { readonly step: OrchestrationV2NativeChildStep }) {
  const { step } = props;
  const stepLabelText =
    step.status !== null && step.status !== "DONE" ? stepLabel(step.status) : undefined;
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        {stepLabel(step.type)}
        {step.status !== null && step.status !== "DONE" ? <Trans> · {stepLabelText}</Trans> : ""}
      </span>
      {step.toolCalls.length === 0 ? null : (
        <code className="whitespace-pre-wrap break-all text-xs text-foreground">
          {step.toolCalls.map((call) => `${call.name} ${call.input}`).join("\n")}
        </code>
      )}
      {step.text === null ? null : (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
          {step.text}
        </pre>
      )}
    </li>
  );
}
