import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { imagePreviewBackgroundOptions, useImagePreviewBackground } from "./imagePreviewBackground";

export function ImagePreviewBackgroundSelect({ side = "bottom" }: { side?: "top" | "bottom" }) {
  const [background, setBackground] = useImagePreviewBackground();
  return (
    <Select
      items={imagePreviewBackgroundOptions}
      value={background}
      onValueChange={(value) => {
        if (value !== null) setBackground(value);
      }}
    >
      <SelectTrigger
        size="xs"
        aria-label="Image background"
        title="Image background (applies to all image previews)"
        className="w-auto min-w-0 shrink-0"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectPopup side={side}>
        {imagePreviewBackgroundOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
