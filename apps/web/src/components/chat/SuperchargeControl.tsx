import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SUPERCHARGE_CONFIG,
  type ScopedThreadRef,
  type SuperchargeConfig,
  type SuperchargePreset,
  type SuperchargeRun,
} from "@t3tools/contracts";
import { SquareIcon, ZapIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { superchargeEnvironment } from "../../state/supercharge";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureText } from "../continuum/commandFailure";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

const PRESET_LABELS: Record<SuperchargePreset, string> = {
  off: "Off",
  verify: "Verify",
  deep: "Deep",
};
const PRESET_DESCRIPTIONS: Record<SuperchargePreset, string> = {
  off: "Turns run once, as usual.",
  verify: "The agent writes completion checks first; Continuum keeps going until they pass.",
  deep: "Verify, plus a review pass and higher reasoning effort where the model offers it.",
};
const PRESET_LIMITS: Record<Exclude<SuperchargePreset, "off">, SuperchargeConfig["limits"]> = {
  verify: { maxIterations: 3, maxMinutes: 30, maxTokens: null },
  deep: { maxIterations: 5, maxMinutes: 60, maxTokens: null },
};

function superchargeRunLabel(run: SuperchargeRun): string {
  if (run.stop) return `Supercharge stopped: ${run.stop.message}`;
  const passed = run.checks.filter((check) => check.status === "pass").length;
  return `${run.phase} · round ${run.iteration + 1}/${run.limits.maxIterations + 1}${
    run.checks.length > 0 ? ` · ${passed}/${run.checks.length} checks` : ""
  }`;
}

/**
 * Supercharge in the model picker footer: the thread's preset, plus the live run with a stop
 * button. Every follow-up turn is a real turn on the thread, bounded by the limits shown here.
 */
export function SuperchargeControl({ threadRef }: { readonly threadRef: ScopedThreadRef | null }) {
  const query = useEnvironmentQuery(
    threadRef === null
      ? null
      : superchargeEnvironment.state({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  const configure = useAtomCommand(superchargeEnvironment.configure, { reportFailure: false });
  const stop = useAtomCommand(superchargeEnvironment.stop, { reportFailure: false });
  const canConfigure = useAtomValue(
    superchargeEnvironment.configure.permissionAtom(threadRef?.environmentId ?? null),
  );
  const [error, setError] = useState<string | null>(null);
  const config = query.data?.config ?? DEFAULT_SUPERCHARGE_CONFIG;
  const run = query.data?.run ?? null;
  const active = run !== null && run.stop === null;

  const save = async (next: SuperchargeConfig) => {
    if (threadRef === null) return;
    const result = await configure({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, config: next },
    });
    setError(commandFailureText(result, "Supercharge was not changed."));
    query.refresh();
  };

  return (
    <div className="flex items-center gap-1" data-supercharge-control>
      <Menu>
        <MenuTrigger
          disabled={threadRef === null || !canConfigure}
          render={
            <button
              type="button"
              aria-label={`Supercharge: ${PRESET_LABELS[config.preset]}`}
              className={cn(
                "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs outline-none hover:bg-foreground/[0.09] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default disabled:opacity-50 data-popup-open:bg-foreground/[0.09]",
                config.preset === "off" ? "text-muted-foreground" : "text-primary",
              )}
            />
          }
        >
          <ZapIcon aria-hidden="true" className="size-3.5" />
          Supercharge: {PRESET_LABELS[config.preset]}
        </MenuTrigger>
        <MenuPopup side="top" align="start" className="w-80">
          <MenuGroup>
            <MenuGroupLabel>Supercharge</MenuGroupLabel>
            <MenuRadioGroup
              value={config.preset}
              onValueChange={(value) => {
                const preset = value as SuperchargePreset;
                void save({
                  ...config,
                  preset,
                  limits: preset === "off" ? config.limits : PRESET_LIMITS[preset],
                  independentReview: preset === "deep" ? config.independentReview : false,
                });
              }}
            >
              {(Object.keys(PRESET_LABELS) as SuperchargePreset[]).map((preset) => (
                <MenuRadioItem key={preset} value={preset}>
                  <span className="flex flex-col">
                    <span>{PRESET_LABELS[preset]}</span>
                    <span className="text-muted-foreground text-xs">
                      {PRESET_DESCRIPTIONS[preset]}
                    </span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          {config.preset === "deep" ? (
            <>
              <MenuSeparator />
              <MenuCheckboxItem
                checked={config.independentReview}
                onCheckedChange={(checked) => void save({ ...config, independentReview: checked })}
              >
                Independent reviewer (fresh context, sees only the diff and checks)
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={config.allowModelSwitch}
                onCheckedChange={(checked) => void save({ ...config, allowModelSwitch: checked })}
              >
                Allow switching to a stronger model
              </MenuCheckboxItem>
            </>
          ) : null}
          {config.preset !== "off" ? (
            <p className="px-2 pb-2 text-muted-foreground text-xs">
              Up to {config.limits.maxIterations} follow-up turns or {config.limits.maxMinutes}{" "}
              minutes per message. Each follow-up is a real turn and uses your plan or credits.
            </p>
          ) : null}
          {error ? <p className="px-2 pb-2 text-destructive text-xs">{error}</p> : null}
        </MenuPopup>
      </Menu>
      {active && threadRef !== null ? (
        <button
          type="button"
          className="flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-muted-foreground text-xs hover:bg-foreground/[0.09] hover:text-foreground"
          aria-label={`Stop Supercharge (${superchargeRunLabel(run)})`}
          onClick={async () => {
            const result = await stop({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId },
            });
            setError(commandFailureText(result, "Supercharge did not stop."));
            query.refresh();
          }}
        >
          <SquareIcon className="size-3" /> Stop
        </button>
      ) : null}
    </div>
  );
}

/** A one-line status above the composer while a Supercharge run is going or just ended. */
export function SuperchargeRunStatus({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const query = useEnvironmentQuery(
    superchargeEnvironment.state({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const run = query.data?.run ?? null;
  if (run === null || query.data?.config.preset === "off") return null;
  const tone = run.stop
    ? run.stop.reason === "checks-passed"
      ? "text-success"
      : "text-warning"
    : "text-primary";
  return (
    <div
      className={cn("flex items-center gap-1.5 px-1 pb-1 text-xs", tone)}
      data-supercharge-status
      aria-live="polite"
    >
      <ZapIcon className="size-3" />
      <span className="truncate">{superchargeRunLabel(run)}</span>
      {run.checks.length > 0 ? (
        <span className="ms-auto flex gap-0.5" aria-hidden="true">
          {run.checks.map((check) => (
            <span
              key={check.name}
              className={cn(
                "size-1.5 rounded-full",
                check.status === "pass"
                  ? "bg-success"
                  : check.status === "fail"
                    ? "bg-destructive"
                    : "bg-muted-foreground/50",
              )}
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}
