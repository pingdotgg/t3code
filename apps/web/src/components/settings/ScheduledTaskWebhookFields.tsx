import { MAX_WEBHOOK_DELIVERY_AGE_MINUTES } from "@t3tools/contracts";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import type { Dispatch, SetStateAction } from "react";

import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Label } from "../ui/label";
import { Field } from "./ScheduledTaskField";
import type { DraftState } from "./scheduledTasksSettings.logic";
import { WebhookEndpointField } from "./ScheduledTasksSettingsParts6";
import { WebhookFiltersField } from "./ScheduledTasksSettingsParts5";

/** Everything a webhook-scheduled task needs: endpoint, replay/coalesce keys, filters, signature. */
export function ScheduledTaskWebhookFields({
  draft,
  setDraft,
  environmentId,
  liveTask,
}: {
  readonly draft: DraftState;
  readonly setDraft: Dispatch<SetStateAction<DraftState>>;
  readonly environmentId: EnvironmentId;
  readonly liveTask: ScheduledTask | null;
}) {
  return (
    <div className="space-y-4">
      <WebhookEndpointField environmentId={environmentId} task={liveTask} />
      <p className="text-xs text-muted-foreground">
        {
          "Each request runs the prompt. Use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} in the prompt; only what it names reaches the agent."
        }
      </p>
      <Field
        label="Skip requests older than"
        hint="minutes, optional"
        htmlFor="scheduled-task-max-age"
      >
        <Input
          id="scheduled-task-max-age"
          type="number"
          nativeInput
          min={1}
          max={MAX_WEBHOOK_DELIVERY_AGE_MINUTES}
          placeholder="Run every request"
          value={draft.maxDeliveryAgeMinutes}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              maxDeliveryAgeMinutes: event.target.value,
            }))
          }
        />
      </Field>
      <WebhookFiltersField
        filters={draft.filters}
        onChange={(filters) => setDraft((current) => ({ ...current, filters }))}
      />
      <Field
        label="Duplicate request key"
        hint="template, optional"
        htmlFor="scheduled-task-replay-key"
      >
        <Input
          id="scheduled-task-replay-key"
          placeholder="{{headers.delivery-id}}"
          value={draft.replayKey}
          onChange={(event) =>
            setDraft((current) => ({ ...current, replayKey: event.target.value }))
          }
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        Requests with the same key run only once within 7 days.
      </p>
      <Field
        label="Coalesce key"
        hint="template, optional"
        htmlFor="scheduled-task-coalesce-key"
      >
        <Input
          id="scheduled-task-coalesce-key"
          placeholder="{{body.id}}"
          value={draft.coalesceKey}
          onChange={(event) =>
            setDraft((current) => ({ ...current, coalesceKey: event.target.value }))
          }
        />
      </Field>
      <Field
        label="Coalesce window"
        hint="seconds, 10–3600"
        htmlFor="scheduled-task-coalesce-window"
      >
        <Input
          id="scheduled-task-coalesce-window"
          type="number"
          nativeInput
          min={10}
          max={3600}
          placeholder="120"
          value={draft.coalesceWindowSeconds}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              coalesceWindowSeconds: event.target.value,
            }))
          }
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        Coalescing runs the latest payload once when the window from the first delivery
        closes. Empty keys run normally.
      </p>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="scheduled-task-signature">Require signature</Label>
          <p className="text-sm text-muted-foreground">
            Reject requests without a valid HMAC-SHA256 signature of the body.
          </p>
        </div>
        <Switch
          id="scheduled-task-signature"
          checked={draft.signatureEnabled}
          onCheckedChange={(signatureEnabled) =>
            setDraft((current) => ({ ...current, signatureEnabled }))
          }
        />
      </div>
      {draft.signatureEnabled ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Header" htmlFor="scheduled-task-signature-header">
            <Input
              id="scheduled-task-signature-header"
              value={draft.signatureHeader}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  signatureHeader: event.target.value,
                }))
              }
            />
          </Field>
          <Field label="Prefix" htmlFor="scheduled-task-signature-prefix">
            <Input
              id="scheduled-task-signature-prefix"
              value={draft.signaturePrefix}
              placeholder="None"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  signaturePrefix: event.target.value,
                }))
              }
            />
          </Field>
          <Field label="Encoding" htmlFor="scheduled-task-signature-encoding">
            <Select
              value={draft.signatureEncoding}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  signatureEncoding: value === "base64" ? "base64" : "hex",
                }))
              }
            >
              <SelectTrigger size="sm" id="scheduled-task-signature-encoding">
                <SelectValue>{draft.signatureEncoding}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="hex">hex</SelectItem>
                <SelectItem value="base64">base64</SelectItem>
              </SelectPopup>
            </Select>
          </Field>
          <Field label="Secret" htmlFor="scheduled-task-signature-secret">
            <Input
              id="scheduled-task-signature-secret"
              type="password"
              autoComplete="off"
              value={draft.signatureSecret}
              placeholder={
                liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret
                  ? "Unchanged"
                  : "Shared secret"
              }
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  signatureSecret: event.target.value,
                }))
              }
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}
