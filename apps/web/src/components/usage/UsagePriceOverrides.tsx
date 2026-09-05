import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, UsageModelPriceOverride } from "@t3tools/contracts";
import { useState } from "react";

import { isElectron } from "../../env";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import type { EnvironmentUsageStatus } from "../../state/usage";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "../settings/ProviderSettingsPanel.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { parseUsagePriceForm, USAGE_PRICE_FIELDS, usagePriceForm } from "./usagePriceForm";

export function UsagePriceOverrides({
  usage,
}: {
  readonly usage: readonly EnvironmentUsageStatus[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Model prices
      </Button>
      {open ? <ModelPricesDialog usage={usage} onOpenChange={setOpen} /> : null}
    </>
  );
}

function ModelPricesDialog({
  usage,
  onOpenChange,
}: {
  readonly usage: readonly EnvironmentUsageStatus[];
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(primaryEnvironmentId);
  const environment =
    environments.find((entry) => entry.environmentId === selectedId) ?? environments[0];
  const summary = usage.find(
    (entry) => entry.environmentId === environment?.environmentId,
  )?.summary;
  const models = [...new Set(summary?.buckets.map((bucket) => bucket.model) ?? [])].sort();

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Model prices</DialogTitle>
          <DialogDescription>
            Override estimated costs using USD per million tokens. Prices apply to all saved history
            on the selected environment.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-5 pb-6">
          {environment ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="usage-prices-environment">Environment</Label>
                <Select
                  value={environment.environmentId}
                  onValueChange={(value) => {
                    const next = environments.find((entry) => entry.environmentId === value);
                    if (next) setSelectedId(next.environmentId);
                  }}
                >
                  <SelectTrigger id="usage-prices-environment">
                    <SelectValue>{environment.label}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {environments.map((entry) => (
                      <SelectItem key={entry.environmentId} value={entry.environmentId}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <EnvironmentModelPrices
                key={environment.environmentId}
                environment={environment}
                models={models}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Connect an environment to set model prices.
            </p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function EnvironmentModelPrices({
  environment,
  models,
}: {
  readonly environment: EnvironmentPresentation;
  readonly models: readonly string[];
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environment.environmentId));
  const session = useEnvironmentSessionState(environment.environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [form, setForm] = useState(usagePriceForm());
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prices = settings?.usagePriceOverrides ?? {};
  const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
  const access = isPrimary
    ? resolvePrimaryOperateAccess({
        isPrimary,
        hasDesktopBridge: isElectron,
        session: session.data,
        isPending: session.isPending,
        hasError: session.hasError,
      })
    : resolveRemoteOperateAccess({
        session: session.data,
        isPending: session.isPending,
        hasError: session.hasError,
      });
  const supportsOverrides =
    environment.serverConfig?.environment.capabilities.usagePriceOverrides === true;
  const unavailable =
    environment.connection.phase !== "connected"
      ? "Connect this environment to change its model prices."
      : settings === null
        ? "Loading model prices..."
        : !supportsOverrides
          ? "Update this environment's server to set model prices."
          : access === "pending"
            ? "Checking permissions..."
            : access === "denied"
              ? "This session can view model prices but cannot change them."
              : null;
  const readOnly = unavailable !== null || pending;
  const parsed = parseUsagePriceForm(form);
  const duplicate = editingModel === null && parsed !== null && Object.hasOwn(prices, parsed.model);

  const reset = () => {
    setEditingModel(null);
    setForm(usagePriceForm());
    setError(null);
  };
  const save = async (model: string, price: UsageModelPriceOverride | null) => {
    if (readOnly) return;
    setPending(true);
    setError(null);
    try {
      const result = await updateSettings({
        environmentId: environment.environmentId,
        input: { patch: { usagePriceOverrides: { [model]: price } } },
      });
      if (result._tag === "Failure") {
        setError("Could not save model prices. Try again.");
      } else if (price !== null || editingModel === model) {
        reset();
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      {Object.keys(prices).length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {Object.entries(prices)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([model, price]) => (
              <li key={model} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="break-all text-sm font-medium">{model}</p>
                  <p className="text-xs text-muted-foreground">
                    Input ${price.inputCostPerMillionTokens} · Output $
                    {price.outputCostPerMillionTokens}
                    <br />
                    Cache read $
                    {price.cacheReadCostPerMillionTokens ?? price.inputCostPerMillionTokens}
                    {" · "}Cache write $
                    {price.cacheWriteCostPerMillionTokens ?? price.inputCostPerMillionTokens}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={readOnly}
                  aria-label={`Edit price for ${model}`}
                  onClick={() => {
                    setEditingModel(model);
                    setForm(usagePriceForm(model, price));
                    setError(null);
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={readOnly}
                  aria-label={`Remove price for ${model}`}
                  onClick={() => void save(model, null)}
                >
                  Remove
                </Button>
              </li>
            ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No custom prices. Public model pricing is used when available.
        </p>
      )}
      {unavailable ? <p className="text-sm text-muted-foreground">{unavailable}</p> : null}
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed && !duplicate) void save(parsed.model, parsed.price);
        }}
      >
        <fieldset disabled={readOnly} className="grid min-w-0 gap-4">
          <legend className="mb-3 text-sm font-medium">
            {editingModel === null ? "Add model price" : "Edit model price"}
          </legend>
          <div className="grid gap-1.5">
            <Label htmlFor="usage-price-model">Model ID</Label>
            <Input
              id="usage-price-model"
              list="usage-price-models"
              value={form.model}
              disabled={editingModel !== null}
              placeholder="Exact model ID from usage"
              autoComplete="off"
              spellCheck={false}
              required
              onChange={(event) => setForm({ ...form, model: event.target.value })}
            />
            <datalist id="usage-price-models">
              {models.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            {duplicate ? (
              <p role="alert" className="text-xs text-destructive">
                This model already has a price. Use Edit to change it.
              </p>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {USAGE_PRICE_FIELDS.map((field) => (
              <div key={field.key} className="grid gap-1.5">
                <Label htmlFor={`usage-price-${field.key}`}>
                  {field.label}
                  {field.optional ? " (optional)" : ""}
                </Label>
                <Input
                  id={`usage-price-${field.key}`}
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  required={!field.optional}
                  value={form[field.key]}
                  placeholder={field.optional ? "Use input rate" : "0.00"}
                  onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Blank cache rates use the input price. Enter 0 for free tokens. Model IDs match exactly.
            Remove a price to restore automatic pricing.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            {editingModel !== null ? (
              <Button variant="outline" onClick={reset}>
                Cancel
              </Button>
            ) : null}
            <Button type="submit" disabled={parsed === null || duplicate || readOnly}>
              {pending ? "Saving..." : editingModel === null ? "Add price" : "Save price"}
            </Button>
          </div>
        </fieldset>
      </form>
    </>
  );
}
