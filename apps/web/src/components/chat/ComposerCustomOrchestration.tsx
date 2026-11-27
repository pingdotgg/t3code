import { T, useGT } from "gt-react";
import { CheckIcon, WorkflowIcon } from "lucide-react";

/** The model picker's entry for Custom Orchestration. It is a mode, so it sits under the list. */
export function ComposerCustomOrchestrationRow(props: {
  selected: boolean;
  /** The configured orchestrator's model name, or null while none is configured. */
  orchestratorName: string | null;
  blockReason: string | null;
  onPick: () => void;
}) {
  const gt = useGT();
  const description =
    props.orchestratorName === null
      ? gt("Set up in Settings → Orchestration")
      : (props.blockReason ??
        gt("{model} delegates by your settings", { model: props.orchestratorName }));
  return (
    <div className="border-t border-border/70 px-2 py-1.5">
      <button
        type="button"
        aria-pressed={props.selected}
        // Without an orchestrator the row opens the settings that choose one.
        disabled={!props.selected && props.orchestratorName !== null && props.blockReason !== null}
        data-custom-orchestration-row
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-foreground outline-none hover:bg-foreground/[0.09] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-64 aria-pressed:bg-foreground/[0.09]"
        onClick={props.onPick}
      >
        <WorkflowIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">
            <T>Custom Orchestration</T>
          </span>
          <span className="text-muted-foreground text-xs">{description}</span>
        </span>
        {props.selected ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      </button>
    </div>
  );
}

/** Stands in for the effort column: this mode's model and effort come from settings. */
export function ComposerCustomOrchestrationColumn(props: {
  orchestratorName: string | null;
  effort: string | null;
  blockReason: string | null;
  onEditSettings: () => void;
}) {
  const gt = useGT();
  return (
    <>
      <div className="shrink-0 px-3 pt-2.5">
        <div className="flex h-8.25 -translate-y-px items-center border-b border-border/70 pb-1.5 text-muted-foreground text-sm">
          {gt("Orchestrator")}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-3 pt-2.5 pb-2 text-sm">
        {props.orchestratorName !== null ? (
          <div className="flex flex-col">
            <span className="wrap-anywhere text-foreground">{props.orchestratorName}</span>
            {props.effort ? (
              <span className="text-muted-foreground text-xs">{props.effort}</span>
            ) : null}
          </div>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {props.blockReason ?? <T>Delegates your task kinds and runs your review commands.</T>}
        </p>
        <button
          type="button"
          data-effort-row
          className="-mx-1 cursor-pointer self-start rounded-sm px-1 py-0.5 text-foreground text-xs underline underline-offset-2 outline-none hover:bg-foreground/[0.09] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={props.onEditSettings}
        >
          <T>Edit settings</T>
        </button>
      </div>
    </>
  );
}
