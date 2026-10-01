import {
  AlertDialog,
  Host,
  OutlinedTextField,
  Text,
  TextButton,
  useNativeState,
} from "@expo/ui/jetpack-compose";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import type { MaterialConfirmDialogProps } from "./MaterialConfirmDialog";

export function MaterialConfirmDialog(props: MaterialConfirmDialogProps) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const titleTypography = useScaledTextRole("title");
  const bodyTypography = useScaledTextRole("footnote");
  const inputTypography = useScaledTextRole("body");
  const inputState = useNativeState(props.inputInitialValue ?? "");
  const inputSelection = useNativeState({ start: 0, end: props.inputInitialValue?.length ?? 0 });
  const confirm = () => {
    if (props.confirmDisabled) return;
    const value = props.inputInitialValue === undefined ? undefined : inputState.get();
    if (value !== undefined && !value.trim()) return;
    props.onConfirm(value);
  };
  return (
    <Host
      colorScheme={themeAppearance}
      ignoreSafeAreaKeyboardInsets
      style={{ height: 0, width: 0 }}
    >
      <AlertDialog
        onDismissRequest={props.onCancel}
        tonalElevation={0}
        colors={{
          containerColor: colors["--color-card-alt"],
          titleContentColor: colors["--color-foreground"],
          textContentColor: colors["--color-foreground-secondary"],
        }}
      >
        <AlertDialog.Title>
          <Text style={titleTypography}>{props.request.title}</Text>
        </AlertDialog.Title>
        {props.inputInitialValue !== undefined ? (
          <AlertDialog.Text>
            <OutlinedTextField
              autoFocus
              singleLine
              value={inputState}
              selection={inputSelection}
              onValueChange={props.onInputChange}
              textStyle={inputTypography}
              keyboardOptions={{ imeAction: "done" }}
              keyboardActions={{
                onDone: confirm,
              }}
              colors={{
                focusedTextColor: colors["--color-foreground"],
                unfocusedTextColor: colors["--color-foreground"],
                focusedIndicatorColor: colors["--color-focus"],
                unfocusedIndicatorColor: colors["--color-border"],
                cursorColor: colors["--color-focus"],
              }}
            >
              <OutlinedTextField.Label>
                <Text style={bodyTypography}>{props.request.title}</Text>
              </OutlinedTextField.Label>
            </OutlinedTextField>
          </AlertDialog.Text>
        ) : props.request.message ? (
          <AlertDialog.Text>
            <Text style={bodyTypography}>{props.request.message}</Text>
          </AlertDialog.Text>
        ) : null}
        <AlertDialog.DismissButton>
          <TextButton
            onClick={props.onCancel}
            colors={{ contentColor: colors["--color-primary-text"] }}
          >
            <Text style={bodyTypography}>{props.request.cancelText ?? "Cancel"}</Text>
          </TextButton>
        </AlertDialog.DismissButton>
        <AlertDialog.ConfirmButton>
          <TextButton
            onClick={confirm}
            enabled={!props.confirmDisabled}
            colors={{
              contentColor:
                colors[
                  props.request.destructive ? "--color-danger-foreground" : "--color-primary-text"
                ],
            }}
          >
            <Text style={bodyTypography}>{props.request.confirmText}</Text>
          </TextButton>
        </AlertDialog.ConfirmButton>
      </AlertDialog>
    </Host>
  );
}
