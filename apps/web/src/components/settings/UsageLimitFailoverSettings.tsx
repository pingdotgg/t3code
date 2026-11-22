import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export interface FailoverInstanceOption {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
}

export function UsageLimitFailoverSettings({
  environmentId,
  enabled,
  order,
  instances,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
  readonly order: ReadonlyArray<ProviderInstanceId>;
  readonly instances: ReadonlyArray<FailoverInstanceOption>;
  readonly readOnly: boolean;
}) {
  const searchableSetting = useSearchableSetting();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const labelFor = (instanceId: ProviderInstanceId) =>
    instances.find((instance) => instance.instanceId === instanceId)?.label ?? instanceId;
  const addable = instances.filter((instance) => !order.includes(instance.instanceId));
  const setOrder = (next: ReadonlyArray<ProviderInstanceId>) =>
    updateSettings({ usageLimitFailoverOrder: next });
  const move = (index: number, offset: -1 | 1) => {
    const next = [...order];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    setOrder(next);
  };

  return (
    <SettingsSection {...searchableSetting("usage-limit-failover")}>
      <SettingsRow
        title="Switch provider on usage limit"
        description="When a thread hits a usage limit, continue it on the next provider in this list instead of waiting for the reset. The conversation moves with the thread; a different account or provider does not keep the previous session's tool state."
        control={
          <Switch
            aria-label="Switch provider on usage limit"
            checked={enabled}
            disabled={readOnly}
            onCheckedChange={(checked) =>
              updateSettings({ usageLimitFailoverEnabled: Boolean(checked) })
            }
          />
        }
      />
      {order.length === 0 ? (
        <SettingsRow
          title="No fallback order."
          description="Add providers in the order to try them. A limited thread moves to the next entry after its current provider."
        />
      ) : (
        order.map((instanceId, index) => (
          <SettingsRow
            key={instanceId}
            title={`${index + 1}. ${labelFor(instanceId)}`}
            description={
              instances.some((instance) => instance.instanceId === instanceId)
                ? undefined
                : "Not configured on this device; failover skips it."
            }
            control={
              !readOnly ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={index === 0}
                    aria-label={`Move ${labelFor(instanceId)} up`}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={index === order.length - 1}
                    aria-label={`Move ${labelFor(instanceId)} down`}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Remove ${labelFor(instanceId)}`}
                    onClick={() => setOrder(order.filter((id) => id !== instanceId))}
                  >
                    <XIcon />
                  </Button>
                </div>
              ) : null
            }
          />
        ))
      )}
      {!readOnly && addable.length > 0 ? (
        <SettingsRow
          title="Add to order"
          control={
            <Select
              value={null}
              onValueChange={(value) => {
                const instance = addable.find((option) => option.instanceId === value);
                if (instance) setOrder([...order, instance.instanceId]);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-52"
                aria-label="Add provider to order"
              >
                <SelectValue>{() => "Choose provider"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {addable.map((instance) => (
                  <SelectItem hideIndicator key={instance.instanceId} value={instance.instanceId}>
                    {instance.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
