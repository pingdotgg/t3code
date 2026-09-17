import type { ConfirmDialogRequest } from "./ConfirmDialogHost";

export interface MaterialConfirmDialogProps {
  readonly request: Pick<
    ConfirmDialogRequest,
    "title" | "message" | "cancelText" | "confirmText" | "destructive"
  >;
  readonly inputInitialValue?: string;
  readonly onInputChange?: (value: string) => void;
  readonly confirmDisabled?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (inputValue?: string) => void;
}

export function MaterialConfirmDialog(_props: MaterialConfirmDialogProps) {
  return null;
}
