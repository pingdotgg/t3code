import { ExternalLinkIcon } from "lucide-react";
import { DiffFileHeaderActionButton } from "./DiffFileHeaderActionButton";

export function DiffFileOpenInEditorButton({
  filePath,
  disabled,
  onOpen,
}: {
  filePath: string;
  disabled: boolean;
  onOpen: (filePath: string) => void;
}) {
  return (
    <DiffFileHeaderActionButton
      ariaLabel={`Open ${filePath} in editor`}
      disabled={disabled}
      onClick={() => onOpen(filePath)}
      tooltip="Open in editor"
    >
      <ExternalLinkIcon aria-hidden />
    </DiffFileHeaderActionButton>
  );
}
