import { useGT } from "gt-react";
import { useCitationDestination } from "../chat/citationDestination";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
export function CitationDestinationSetting() {
  const gt = useGT();
  const [destination, setDestination] = useCitationDestination();
  return (
    <Select
      value={destination}
      onValueChange={(value) => {
        if (value === "inline" || value === "tray") setDestination(value);
      }}
    >
      <SelectTrigger aria-label={gt("New citations go")}>
        <SelectValue>
          {destination === "inline" ? gt("Inline (default)") : gt("In the tray")}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="inline">{gt("Inline (default)")}</SelectItem>
        <SelectItem value="tray">{gt("In the tray")}</SelectItem>
      </SelectPopup>
    </Select>
  );
}
