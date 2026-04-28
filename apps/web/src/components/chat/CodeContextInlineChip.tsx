import { cn } from "~/lib/utils";
import { buildCodeContextInlineChipLabel, type CodeContextSelection } from "~/lib/codeContext";
import { getVscodeIconUrlForEntry, inferEntryKindFromPath } from "~/vscode-icons";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readResolvedThemeModeFromDocument } from "../../theme";

interface CodeContextInlineChipProps {
  selection: Pick<CodeContextSelection, "filePath" | "lineStart" | "lineEnd">;
  tooltipText: string;
}

export function CodeContextInlineChip(props: CodeContextInlineChipProps) {
  const { selection, tooltipText } = props;
  const theme = readResolvedThemeModeFromDocument();
  const label = buildCodeContextInlineChipLabel(selection);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "max-w-full")}>
            <img
              alt=""
              aria-hidden="true"
              className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
              loading="lazy"
              src={getVscodeIconUrlForEntry(
                selection.filePath,
                inferEntryKindFromPath(selection.filePath),
                theme,
              )}
            />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}
