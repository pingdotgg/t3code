import { AuthMcpClientAccess } from "@t3tools/contracts";
import { useId } from "react";

import { accessConfig } from "../auth/ConnectAgentSurface";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

import { translateDynamic } from "../../i18nCore";

const td = (key: string, options?: Record<string, unknown>) =>
  translateDynamic(`shell:${key}`, options);

const ACCESS_LABEL_KEYS: Record<AuthMcpClientAccess, string> = {
  "read-only": "readOnly",
  "approval-required": "approvalRequired",
  "auto-accept-edits": "autoAcceptEdits",
  auto: "auto",
  "full-access": "fullAccess",
};
const accessText = (access: AuthMcpClientAccess, field: "label" | "description") =>
  translateDynamic(`onboarding:access.${ACCESS_LABEL_KEYS[access]}.${field}`);

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
  const selected = accessConfig[value];
  const selectedLabel = accessText(value, "label");
  return (
    <div className="space-y-1.5">
      <span id={labelId} className="block text-xs font-medium">
        {td("whatAgentsMayDo")}
      </span>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onChange(next as AuthMcpClientAccess);
        }}
      >
        <SelectTrigger aria-labelledby={labelId}>
          <SelectValue>
            <span className="flex items-center gap-2">
              <selected.icon aria-hidden className="size-4" />
              {selectedLabel}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {AuthMcpClientAccess.literals.map((option) => {
            const { icon: Icon } = accessConfig[option];
            return (
              <SelectItem key={option} value={option} hideIndicator>
                <span className="grid min-w-0 gap-0.5 py-0.5">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    {accessText(option, "label")}
                  </span>
                  <span className="text-xs leading-4 text-muted-foreground">
                    {accessText(option, "description")}
                  </span>
                </span>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
      <p className="text-xs text-muted-foreground">
        {accessText(value, "description")} {td("accessPickerNote")}
      </p>
    </div>
  );
}
