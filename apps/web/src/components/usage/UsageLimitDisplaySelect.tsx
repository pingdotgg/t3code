import { persistClientSettingsPatch, useClientSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function UsageLimitDisplaySelect() {
  const mode = useClientSettings((settings) => settings.usageLimitDisplay);
  return (
    <Select
      value={mode}
      onValueChange={(value) => {
        if (value === "remaining" || value === "used") {
          void persistClientSettingsPatch({ usageLimitDisplay: value });
        }
      }}
    >
      <SelectTrigger size="sm" aria-label="Usage limit display">
        <SelectValue>{mode === "used" ? "Used (fills up)" : "Remaining (empties)"}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value="remaining">Remaining (empties)</SelectItem>
        <SelectItem value="used">Used (fills up)</SelectItem>
      </SelectPopup>
    </Select>
  );
}
