import { NativeThemeHost } from "./NativeThemeHost.android";
import {
  AlertDialog,
  OutlinedTextField,
  Text,
  TextButton,
  useNativeState,
} from "@expo/ui/jetpack-compose";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

type DialogRequest =
  | { readonly kind: "confirm"; readonly request: ConfirmDialogRequest }
  | { readonly kind: "text-input"; readonly request: TextInputDialogRequest };

let presentRequest: ((request: DialogRequest) => void) | null = null;

export function confirm(request: ConfirmDialogRequest): void {
  presentRequest?.({ kind: "confirm", request });
}

export function prompt(request: TextInputDialogRequest): void {
  presentRequest?.({ kind: "text-input", request });
}

/** Android presenter for Dialog.confirm and Dialog.prompt; mounted once at the app root. */
export function Host() {
  const [presented, setPresented] = useState<(DialogRequest & { readonly id: number }) | null>(
    null,
  );
  const [inputValue, setInputValue] = useState("");
  const nextPresentationId = useRef(0);
  useEffect(() => {
    presentRequest = (request) => {
      setInputValue(request.kind === "text-input" ? request.request.initialValue : "");
      setPresented({ ...request, id: ++nextPresentationId.current });
    };
    return () => {
      presentRequest = null;
    };
  }, []);

  const handleCancel = useCallback(() => {
    setPresented(null);
    presented?.request.onCancel?.();
  }, [presented]);

  const handleConfirm = useCallback(
    (nativeInputValue?: string) => {
      setPresented(null);
      if (presented?.kind === "confirm") {
        presented.request.onConfirm();
      } else if (presented?.kind === "text-input") {
        presented.request.onConfirm(nativeInputValue ?? inputValue);
      }
    },
    [inputValue, presented],
  );

  return presented ? (
    <DialogPresentation
      key={presented.id}
      request={presented.request}
      inputInitialValue={
        presented.kind === "text-input" ? presented.request.initialValue : undefined
      }
      onInputChange={setInputValue}
      onCancel={handleCancel}
      onConfirm={handleConfirm}
    />
  ) : null;
}

function DialogPresentation(props: DialogPresentationProps) {
  const { themeVariables: colors } = useAppearancePreferences();
  const titleTypography = useScaledTextRole("title");
  const bodyTypography = useScaledTextRole("footnote");
  const inputTypography = useScaledTextRole("body");
  const inputState = useNativeState(props.inputInitialValue ?? "");
  const inputSelection = useNativeState({ start: 0, end: props.inputInitialValue?.length ?? 0 });
  const confirm = () => {
    const value = props.inputInitialValue === undefined ? undefined : inputState.get();
    props.onConfirm(value);
  };
  return (
    <NativeThemeHost ignoreSafeAreaKeyboardInsets style={{ height: 0, width: 0 }}>
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
    </NativeThemeHost>
  );
}

interface DialogPresentationProps {
  readonly request: Pick<
    ConfirmDialogRequest,
    "title" | "message" | "cancelText" | "confirmText" | "destructive"
  >;
  readonly inputInitialValue?: string;
  readonly onInputChange?: (value: string) => void;
  readonly onCancel: () => void;
  readonly onConfirm: (inputValue?: string) => void;
}
