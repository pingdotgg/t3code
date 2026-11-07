import { useCitationDestination } from "../chat/citationDestination";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
export function CitationDestinationSetting() {
  const [destination, setDestination] = useCitationDestination();
  return (
    <Select
      value={destination}
      onValueChange={(value) => {
        if (value === "inline" || value === "tray") setDestination(value);
      }}
    >
      <SelectTrigger aria-label="New citations go">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="inline">Inline (default)</SelectItem>
        <SelectItem value="tray">In the tray</SelectItem>
      </SelectPopup>
    </Select>
  );
}
