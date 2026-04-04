import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "./ui/button";

export function CopyValueButton({ label, value }: { label: string; value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  return (
    <Button
      size="xs"
      variant="outline"
      className="shrink-0"
      onClick={() => copyToClipboard(value, undefined)}
      aria-label={`Copy ${label}`}
    >
      {isCopied ? "Copied" : "Copy"}
    </Button>
  );
}
