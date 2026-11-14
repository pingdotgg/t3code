import type {
  CommandPaletteOpenIntent,
  CommandPaletteReturnContext,
} from "../CommandPalette.logic";

export interface CommandPaletteDialogProps {
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openChildSearch: (
    mode: "files" | "content",
    context: CommandPaletteReturnContext,
  ) => void;
  readonly initialContext: CommandPaletteReturnContext | undefined;
}
