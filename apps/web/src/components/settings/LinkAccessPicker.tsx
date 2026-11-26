import { AuthMcpClientAccess } from "@t3tools/contracts";
import { T, useMessages } from "gt-react";
import { useId } from "react";

import { accessConfig } from "../auth/ConnectAgentSurface";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function AccessLevelSelect({
  value,
  onChange,
  disabled = false,
  unavailable,
  compact = false,
  ...labelling
}: {
  readonly value: AuthMcpClientAccess;
  readonly onChange: (access: AuthMcpClientAccess) => void;
  readonly disabled?: boolean;
  readonly unavailable?: ReadonlyMap<AuthMcpClientAccess, string>;
  readonly compact?: boolean;
} & ({ readonly "aria-labelledby": string } | { readonly "aria-label": string })) {
  const m = useMessages();
  const selected = accessConfig[value];
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next as AuthMcpClientAccess);
      }}
    >
      <SelectTrigger
        {...labelling}
        {...(compact ? { size: "xs" as const, className: "w-auto min-w-0" } : {})}
      >
        <SelectValue>
          <span className="flex items-center gap-2">
            <selected.icon aria-hidden className={compact ? "size-3.5" : "size-4"} />
            {m(selected.label)}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {AuthMcpClientAccess.literals.map((option) => {
          const { label, description, icon: Icon } = accessConfig[option];
          const reason = unavailable?.get(option);
          return (
            <SelectItem key={option} value={option} disabled={reason !== undefined} hideIndicator>
              <span className="grid min-w-0 gap-0.5 py-0.5">
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  {m(label)}
                </span>
                <span className="text-xs leading-4 text-muted-foreground">
                  {reason ?? m(description)}
                </span>
              </span>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
}

/** What agents here may do in an environment being linked, with what that does not allow. */
export function LinkAccessPicker({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: AuthMcpClientAccess;
  readonly onChange: (access: AuthMcpClientAccess) => void;
  readonly disabled?: boolean;
}) {
  const labelId = useId();
  const m = useMessages();
  return (
    <div className="space-y-1.5">
      <span id={labelId} className="block text-xs font-medium">
        <T>What agents here may do there</T>
      </span>
      <AccessLevelSelect
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-labelledby={labelId}
      />
      <p className="text-xs text-muted-foreground">
        {m(accessConfig[value].description)}{" "}
        <T>
          An agent never gets more access there than its own mode here. Below full access, it can
          change only threads this link started, not that machine's own threads, projects or
          settings.
        </T>
      </p>
    </div>
  );
}
