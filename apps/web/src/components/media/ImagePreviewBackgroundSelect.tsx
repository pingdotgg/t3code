import { useGT, useMessages } from "gt-react";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { imagePreviewBackgroundOptions, useImagePreviewBackground } from "./imagePreviewBackground";

export function ImagePreviewBackgroundSelect({ side = "bottom" }: { side?: "top" | "bottom" }) {
  const [background, setBackground] = useImagePreviewBackground();
  const gt = useGT();
  const m = useMessages();
  const items = imagePreviewBackgroundOptions.map((option) => ({
    ...option,
    label: m(option.label),
  }));
  return (
    <Select
      items={items}
      value={background}
      onValueChange={(value) => {
        if (value !== null) setBackground(value);
      }}
    >
      <SelectTrigger
        size="xs"
        aria-label={gt("Image background")}
        title={gt("Image background (applies to all image previews)")}
        className="w-auto min-w-0 shrink-0"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectPopup side={side}>
        {items.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
