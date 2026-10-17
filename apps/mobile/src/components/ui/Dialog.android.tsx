import { NativeThemeHost } from "./NativeThemeHost.android";
import {
  AlertDialog,
  Button,
  OutlinedButton,
  Icon,
  FlowRow,
  Column,
  OutlinedTextField,
  Text,
  useNativeState,
} from "@expo/ui/jetpack-compose";

import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../../features/settings/appearance/useScaledTextRole";

import { useCallback, useEffect, useRef, useState } from "react";
import { themeColorWithContrast } from "../../lib/mobileTheme";
import { Alert, type AlertButton } from "react-native";
import type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";
import { resolveAlertDismissal } from "./dialog-alert";

export type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

type AlertRequest = {
  readonly title: Parameters<typeof Alert.alert>[0];
  readonly message: Parameters<typeof Alert.alert>[1];
  readonly buttons: Parameters<typeof Alert.alert>[2];
  readonly options: Parameters<typeof Alert.alert>[3];
};

type DialogRequest =
  | { readonly kind: "alert"; readonly request: AlertRequest }
  | { readonly kind: "confirm"; readonly request: ConfirmDialogRequest }
  | { readonly kind: "text-input"; readonly request: TextInputDialogRequest };

let presentRequest: ((request: DialogRequest) => void) | null = null;

export function alert(...[title, message, buttons, options]: Parameters<typeof Alert.alert>): void {
  if (!presentRequest) {
    Alert.alert(title, message, buttons, options);
    return;
  }
  const actions = buttons?.length ? buttons.slice(0, 3) : [{ text: "OK" }];
  const normalized = actions.map((action, index) =>
    index === actions.length - 1 ? { ...action, text: action.text || "OK" } : action,
  );
  presentRequest?.({
    kind: "alert",
    request: { title, message, buttons: normalized, options },
  });
}

export function confirm(request: ConfirmDialogRequest): void {
  presentRequest?.({ kind: "confirm", request });
}

export function prompt(request: TextInputDialogRequest): void {
  presentRequest?.({ kind: "text-input", request });
}

/** Android presenter for Dialog.alert, Dialog.confirm and Dialog.prompt; mounted once at the app root. */
export function Host() {
  const [queue, setQueue] = useState<readonly (DialogRequest & { readonly id: number })[]>([]);
  const nextPresentationId = useRef(0);
  const closedId = useRef<number | null>(null);
  const presented = queue[0];
  useEffect(() => {
    const present = (request: DialogRequest) => {
      const id = ++nextPresentationId.current;
      setQueue((current) => [...current, { ...request, id }]);
    };
    presentRequest = present;
    return () => {
      if (presentRequest === present) presentRequest = null;
    };
  }, []);

  // The native dialog lingers until the next render, so a double tap must not run an action twice.
  const close = useCallback(
    (then?: () => void) => {
      if (!presented || closedId.current === presented.id) return;
      closedId.current = presented.id;
      setQueue((current) => current.filter((dialog) => dialog.id !== presented.id));
      then?.();
    },
    [presented],
  );

  const handleCancel = useCallback(() => {
    if (presented?.kind === "alert") {
      const dismissal = resolveAlertDismissal({
        buttons: presented.request.buttons ?? [{ text: "OK" }],
        options: presented.request.options,
      });
      if (dismissal.kind === "dismiss") close(presented.request.options?.onDismiss);
      else if (dismissal.kind === "press") close(() => dismissal.button.onPress?.());
    } else {
      close(presented?.request.onCancel);
    }
  }, [close, presented]);

  const handleConfirm = useCallback(
    (nativeInputValue?: string) => {
      if (presented?.kind === "confirm") {
        close(presented.request.onConfirm);
      } else if (presented?.kind === "text-input") {
        const request = presented.request;
        close(() => request.onConfirm(nativeInputValue ?? request.initialValue));
      }
    },
    [close, presented],
  );

  if (presented?.kind === "alert") {
    const actions = presented.request.buttons ?? [{ text: "OK" }];
    const dismissal = resolveAlertDismissal({
      buttons: actions,
      options: presented.request.options,
    });
    return (
      <DialogPresentation
        key={presented.id}
        request={{
          title: presented.request.title ?? "",
          message: presented.request.message ?? undefined,
          confirmText: "",
        }}
        alertActions={actions}
        dismissable={dismissal.kind !== "ignore"}
        onAlertAction={(action) => close(() => action.onPress?.())}
        onCancel={handleCancel}
        onConfirm={handleConfirm}
      />
    );
  }

  return presented ? (
    <DialogPresentation
      key={presented.id}
      request={presented.request}
      inputInitialValue={
        presented.kind === "text-input" ? presented.request.initialValue : undefined
      }
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
  const [inputBlank, setInputBlank] = useState(
    props.inputInitialValue !== undefined && !props.inputInitialValue.trim(),
  );
  const inputSelection = useNativeState({ start: 0, end: props.inputInitialValue?.length ?? 0 });
  const confirm = () => {
    const value = props.inputInitialValue === undefined ? undefined : inputState.get();
    if (value !== undefined && !value.trim()) return;
    props.onConfirm(value);
  };
  const actions = props.alertActions ?? [
    { text: props.request.cancelText ?? "Cancel", onPress: props.onCancel },
    {
      text: props.request.confirmText,
      style: props.request.destructive ? ("destructive" as const) : ("default" as const),
      onPress: confirm,
    },
  ];
  const destructive = actions.some((action) => action.style === "destructive");
  // Error text colors can be pastel in dark themes. Filled actions need a white-label contrast pair.
  const destructiveFill = themeColorWithContrast(colors["--color-danger-foreground"], "#ffffff");
  const renderAction = (action: AlertButton, index: number) => {
    const isDestructive = action.style === "destructive";
    const isPrimary = isDestructive || index === actions.length - 1;
    const Component = isPrimary ? Button : OutlinedButton;
    return (
      <Component
        key={index}
        onClick={() => (props.alertActions ? props.onAlertAction?.(action) : action.onPress?.())}
        enabled={!inputBlank || index !== actions.length - 1}
        colors={{
          containerColor: isDestructive
            ? destructiveFill
            : isPrimary
              ? colors["--color-prominent-action"]
              : "#00000000",
          contentColor: isDestructive
            ? "#ffffff"
            : isPrimary
              ? colors["--color-prominent-action-foreground"]
              : colors["--color-foreground"],
        }}
      >
        <Text style={bodyTypography}>{action.text ?? ""}</Text>
      </Component>
    );
  };
  return (
    <NativeThemeHost ignoreSafeAreaKeyboardInsets style={{ height: 0, width: 0 }}>
      <AlertDialog
        onDismissRequest={props.onCancel}
        properties={{
          dismissOnBackPress: props.dismissable ?? true,
          dismissOnClickOutside: props.dismissable ?? true,
        }}
        tonalElevation={0}
        colors={{
          containerColor: colors["--color-card"],
          titleContentColor: colors["--color-foreground"],
          textContentColor: colors["--color-foreground-secondary"],
        }}
      >
        <AlertDialog.Title>
          <Column verticalArrangement={{ spacedBy: 16 }}>
            {destructive ? (
              <Icon
                source={require("../../../assets/icons/delete.xml")}
                tint={colors["--color-danger-foreground"]}
                size={24}
              />
            ) : null}
            <Text style={titleTypography}>{props.request.title}</Text>
          </Column>
        </AlertDialog.Title>
        {props.inputInitialValue !== undefined ? (
          <AlertDialog.Text>
            <OutlinedTextField
              autoFocus
              singleLine
              value={inputState}
              selection={inputSelection}
              onValueChange={(value) => setInputBlank(!value.trim())}
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
        {actions.length > 1 ? (
          <AlertDialog.DismissButton>
            <FlowRow>{actions.slice(0, -1).map(renderAction)}</FlowRow>
          </AlertDialog.DismissButton>
        ) : null}
        {actions.length > 0 ? (
          <AlertDialog.ConfirmButton>
            {renderAction(actions[actions.length - 1]!, actions.length - 1)}
          </AlertDialog.ConfirmButton>
        ) : null}
      </AlertDialog>
    </NativeThemeHost>
  );
}

interface DialogPresentationProps {
  readonly alertActions?: readonly AlertButton[];
  readonly onAlertAction?: (action: AlertButton) => void;
  readonly dismissable?: boolean;
  readonly request: Pick<
    ConfirmDialogRequest,
    "title" | "message" | "cancelText" | "confirmText" | "destructive"
  >;
  readonly inputInitialValue?: string;
  readonly onCancel: () => void;
  readonly onConfirm: (inputValue?: string) => void;
}
