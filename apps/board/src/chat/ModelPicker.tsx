import { Check, ChevronUp } from "lucide-react";
import { useId } from "react";

import { effortOf, type PickableInstance, type PickerValue } from "../providers/providers";
import { ProviderGlyph } from "../usage/ProviderGlyph";

const row =
  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

/** The trigger's text: the model's name, then its effort. */
function describe(instances: ReadonlyArray<PickableInstance>, value: PickerValue): string {
  const instance = instances.find((entry) => entry.instanceId === value.instanceId);
  const name = instance?.models.find((model) => model.slug === value.model)?.name ?? value.model;
  const control = effortOf(instances, value);
  const level = value.effort || control?.defaultChoice;
  const label = control?.choices.find((choice) => choice.id === level)?.label;
  return label === undefined ? name : `${name} · ${label}`;
}

/**
 * The orchestrator's provider instance, model, and effort for the next turn, as T3's composer picks
 * them. An instance the thread cannot switch to is disabled with T3's reason.
 */
export function ModelPicker({
  instances,
  value,
  onChange,
  switchBlocked,
  open,
  onOpenChange,
}: {
  instances: ReadonlyArray<PickableInstance>;
  value: PickerValue;
  onChange: (next: PickerValue) => void;
  /** T3's reason a started thread cannot move to another instance, with the instance it stays on. */
  switchBlocked: { readonly reason: string; readonly stayOn: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const panelId = useId();
  const selected = instances.find((instance) => instance.instanceId === value.instanceId);
  const control = effortOf(instances, value);

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (
          open &&
          !(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )
        ) {
          onOpenChange(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          onOpenChange(false);
        }
      }}
    >
      <button
        type="button"
        aria-label="Model"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => onOpenChange(!open)}
        className="flex max-w-56 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted hover:bg-hover hover:text-fg"
      >
        {selected !== undefined && <ProviderGlyph driver={selected.driver} />}
        <span className="min-w-0 truncate">{describe(instances, value)}</span>
        <ChevronUp aria-hidden className={`size-3 shrink-0 ${open ? "" : "rotate-180"}`} />
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Model"
          tabIndex={-1}
          className="outline-none absolute bottom-full left-0 z-20 mb-1 flex max-h-[min(22rem,50vh)] w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto rounded-xl border border-line bg-panel p-2 shadow-panel"
        >
          <div role="group" aria-label="Provider" className="flex flex-col">
            {instances.map((instance) => {
              const blocked =
                switchBlocked !== null && instance.instanceId !== switchBlocked.stayOn;
              const checked = instance.instanceId === value.instanceId;
              return (
                <button
                  key={instance.instanceId}
                  type="button"
                  aria-pressed={checked}
                  disabled={
                    blocked || instance.unavailable !== null || instance.signIn === "signed-out"
                  }
                  onClick={() =>
                    onChange({
                      instanceId: instance.instanceId,
                      model: instance.defaultModel ?? "",
                      effort: "",
                    })
                  }
                  className={row}
                >
                  <ProviderGlyph driver={instance.driver} />
                  <span className="min-w-0 flex-1 truncate text-fg">{instance.name}</span>
                  {instance.signIn === "signed-out" && (
                    <span className="text-[11px] text-red-400">Signed out</span>
                  )}
                  {checked && <Check aria-hidden className="size-3.5 text-muted" />}
                </button>
              );
            })}
            {switchBlocked !== null && (
              <p className="px-2 pt-1 text-[11px] text-muted">{switchBlocked.reason}</p>
            )}
          </div>
          {selected !== undefined && (
            <div
              role="group"
              aria-label="Model list"
              className="flex flex-col border-t border-line pt-2"
            >
              {selected.models.map((model) => (
                <button
                  key={model.slug}
                  type="button"
                  aria-pressed={model.slug === value.model}
                  onClick={() => onChange({ ...value, model: model.slug, effort: "" })}
                  className={row}
                >
                  <span className="min-w-0 flex-1 truncate text-fg">{model.name}</span>
                  {model.slug === value.model && (
                    <Check aria-hidden className="size-3.5 text-muted" />
                  )}
                </button>
              ))}
            </div>
          )}
          {control !== null && (
            <div
              role="group"
              aria-label="Effort"
              className="flex flex-wrap gap-1 border-t border-line pt-2"
            >
              {control.choices.map((choice) => {
                const on = (value.effort || control.defaultChoice) === choice.id;
                return (
                  <button
                    key={choice.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onChange({ ...value, effort: choice.id })}
                    className={`rounded-md border px-2 py-0.5 ${on ? "border-muted bg-hover text-fg" : "border-line text-muted hover:bg-hover"}`}
                  >
                    {choice.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
