import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  SUPERCHARGE_DEFAULT_LIMITS,
  SuperchargeConfig,
  type ScopedThreadRef,
  type SuperchargeThreadState,
} from "@t3tools/contracts";
import { superchargeLabel } from "@t3tools/shared/superchargeWorkflow";
import * as Schema from "effect/Schema";
import { ZapIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { superchargeEnvironment } from "../../state/supercharge";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const validConfig = Schema.is(SuperchargeConfig);
const PRESETS = ["off", "verify", "deep"] as const;

export function SuperchargePickerControl({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef | null;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            type="button"
            variant="ghost"
            disabled={threadRef === null}
            title={threadRef === null ? "Start a thread to configure Supercharge" : undefined}
          />
        }
      >
        <ZapIcon /> Supercharge
      </PopoverTrigger>
      {threadRef ? (
        <PopoverPopup side="top" align="end" width="md" padding="compact">
          <SuperchargeSettings key={threadRef.threadId} threadRef={threadRef} />
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}

function SuperchargeSettings({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = threadRef;
  const query = useEnvironmentQuery(
    superchargeEnvironment.state({ environmentId, input: { threadId } }),
  );
  const state = query.data;
  const refresh = useEffectEvent(() => query.refresh());
  const polling =
    state !== null &&
    (state.config.preset !== "off" || (state.run !== null && state.run.stop === null));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes run progress while the Supercharge popover is open
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [polling]);
  if (query.error) return <p role="alert">{query.error}</p>;
  if (!state) return <p>Loading Supercharge…</p>;
  return <SuperchargeForm threadRef={threadRef} state={state} refresh={query.refresh} />;
}

function SuperchargeForm({
  threadRef,
  state,
  refresh,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly state: SuperchargeThreadState;
  readonly refresh: () => void;
}) {
  const { environmentId, threadId } = threadRef;
  const configure = useAtomCommand(superchargeEnvironment.configure, { reportFailure: false });
  const stop = useAtomCommand(superchargeEnvironment.stop, { reportFailure: false });
  const canConfigure = useAtomValue(superchargeEnvironment.configure.permissionAtom(environmentId));
  const canStop = useAtomValue(superchargeEnvironment.stop.permissionAtom(environmentId));
  const [draft, setDraft] = useState<SuperchargeConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = draft ?? state.config;
  const run = state.run;
  const save = async (stopping: boolean) => {
    setBusy(true);
    setError(null);
    await (async () => {
      const result = stopping
        ? await stop({ environmentId, input: { threadId } })
        : await configure({
            environmentId,
            input: { threadId, config },
          });
      if (result._tag === "Success") {
        setDraft(null);
        refresh();
      } else {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Supercharge could not update.");
      }
    })().catch((error: unknown) => {
      setError(error instanceof Error ? error.message : "Supercharge could not update.");
    });
    setBusy(false);
  };
  return (
    <div className="space-y-3 text-sm">
      <p>Supercharge can run extra turns to verify, fix, and review your changes.</p>
      <label className="block space-y-1">
        <span>Preset</span>
        <select
          className="block w-full rounded border bg-background p-1"
          value={config.preset}
          disabled={!canConfigure || busy}
          onChange={(event) => {
            const preset = PRESETS.find((item) => item === event.currentTarget.value);
            if (preset)
              setDraft({
                ...config,
                preset,
                limits: preset === "off" ? config.limits : SUPERCHARGE_DEFAULT_LIMITS[preset],
              });
          }}
        >
          {PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {superchargeLabel(preset)}
            </option>
          ))}
        </select>
      </label>
      {config.preset !== "off" ? (
        <fieldset disabled={!canConfigure || busy} className="space-y-2">
          <label className="block">
            Follow-up turns
            <Input
              type="number"
              min={1}
              max={8}
              value={config.limits.maxIterations || ""}
              onChange={(event) =>
                setDraft({
                  ...config,
                  limits: { ...config.limits, maxIterations: Number(event.currentTarget.value) },
                })
              }
            />
          </label>
          <label className="block">
            Minutes
            <Input
              type="number"
              min={1}
              max={240}
              value={config.limits.maxMinutes || ""}
              onChange={(event) =>
                setDraft({
                  ...config,
                  limits: { ...config.limits, maxMinutes: Number(event.currentTarget.value) },
                })
              }
            />
          </label>
          <label className="block">
            Token limit
            <Input
              type="number"
              min={1000}
              max={50000000}
              placeholder="No limit"
              value={config.limits.maxTokens ?? ""}
              onChange={(event) =>
                setDraft({
                  ...config,
                  limits: {
                    ...config.limits,
                    maxTokens:
                      event.currentTarget.value === "" ? null : Number(event.currentTarget.value),
                  },
                })
              }
            />
          </label>
          {config.preset === "deep" ? (
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={config.independentReview}
                onChange={(event) =>
                  setDraft({ ...config, independentReview: event.currentTarget.checked })
                }
              />
              Independent review
            </label>
          ) : null}
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {run ? (
        <section aria-label="Run progress" className="space-y-1 rounded border p-2">
          <p className="font-medium capitalize">{run.phase.replaceAll("-", " ")}</p>
          <p>
            Follow-ups {run.iteration} of {run.limits.maxIterations}
          </p>
          {run.tokensUsed === null ? null : (
            <p>
              {run.tokensUsed.toLocaleString()} tokens{run.tokensMeasured ? "" : " (estimated)"}
            </p>
          )}
          <p>{run.stop?.message ?? run.log.at(-1)?.summary}</p>
        </section>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          type="button"
          disabled={!canConfigure || busy || draft === null || !validConfig(config)}
          onClick={() => void save(false)}
        >
          Save
        </Button>
        {run && run.stop === null ? (
          <Button
            size="sm"
            type="button"
            variant="outline"
            disabled={!canStop || busy}
            onClick={() => void save(true)}
          >
            Stop
          </Button>
        ) : null}
      </div>
    </div>
  );
}
