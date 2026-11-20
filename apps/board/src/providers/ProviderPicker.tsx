import { useAtomValue } from "@effect/atom-react";
import { useId } from "react";

import { engineEnvironmentIdAtom } from "../state/projects";
import { ProviderGlyph } from "../usage/ProviderGlyph";
import { effortOf, type PickableInstance, type PickerValue } from "./providers";
import { SignIn } from "./SignIn";

const STATE_TEXT = {
  "signed-in": "Signed in",
  "signed-out": "Signed out",
  unknown: "Sign-in unknown",
} as const;

const stateText = (instance: PickableInstance) =>
  instance.unavailable ??
  (instance.signIn === "signed-in" && instance.account !== null
    ? `Signed in as ${instance.account}`
    : STATE_TEXT[instance.signIn]);

/** The orchestrator's instance, model, and effort. A model the instance does not list can still be typed, as in T3. */
export function ProviderPicker({
  instances,
  value,
  onChange,
  reason,
}: {
  instances: ReadonlyArray<PickableInstance>;
  value: PickerValue;
  onChange: (next: PickerValue) => void;
  /** Why the preselected instance is not the usual default. */
  reason?: string | null;
}) {
  const environmentId = useAtomValue(engineEnvironmentIdAtom);
  const modelListId = useId();
  const selected = instances.find((instance) => instance.instanceId === value.instanceId);
  const effort = effortOf(instances, value);

  if (instances.length === 0) {
    return <p className="text-muted">The engine reports no Claude Code or Codex instance.</p>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div role="radiogroup" aria-label="Provider" className="flex flex-col gap-1">
        {instances.map((instance) => {
          const checked = instance.instanceId === value.instanceId;
          return (
            <label
              key={instance.instanceId}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 has-focus-visible:outline-2 has-focus-visible:outline-focus ${checked ? "border-muted bg-hover" : "border-line hover:bg-hover"}`}
            >
              <input
                type="radio"
                name="provider-instance"
                className="sr-only"
                checked={checked}
                onChange={() =>
                  onChange({
                    instanceId: instance.instanceId,
                    model: instance.defaultModel ?? "",
                    effort: "",
                  })
                }
              />
              <ProviderGlyph driver={instance.driver} />
              <span className="min-w-0 flex-1 truncate text-fg">{instance.name}</span>
              <span
                className={`truncate text-[11px] ${instance.signIn === "signed-out" || instance.unavailable !== null ? "text-red-400" : "text-muted"}`}
              >
                {stateText(instance)}
              </span>
            </label>
          );
        })}
      </div>
      {selected !== undefined && (
        <>
          <label className="flex flex-col gap-1 text-muted">
            Model
            <input
              list={modelListId}
              value={value.model}
              onChange={(event) => onChange({ ...value, model: event.target.value, effort: "" })}
              placeholder={selected.defaultModel ?? "Model"}
              className="min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-fg placeholder:text-faint"
            />
            <datalist id={modelListId}>
              {selected.models.map((model) => (
                <option key={model.slug} value={model.slug}>
                  {model.name}
                </option>
              ))}
            </datalist>
          </label>
          {effort !== null && (
            <label className="flex flex-col gap-1 text-muted">
              Effort
              <select
                value={value.effort || (effort.defaultChoice ?? "")}
                onChange={(event) => onChange({ ...value, effort: event.target.value })}
                className="min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-fg"
              >
                {effort.choices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selected.signIn === "signed-out" && environmentId !== null && (
            <SignIn environmentId={environmentId} instance={selected} />
          )}
        </>
      )}
      {reason !== null && reason !== undefined && (
        <p data-testid="provider-reason" className="text-[11px] text-muted">
          {reason}
        </p>
      )}
    </div>
  );
}
