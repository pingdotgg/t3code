import { Pressable, View } from "react-native";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AppActivityIndicator } from "./AppActivityIndicator";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { IconButton } from "./IconButton";
import { Toolbar } from "./Toolbar";
import { createNativeHeaderMenu } from "./nativeHeaderMenu.ios";
import { useControlTheme } from "./useControlTheme";
import type { SheetCloseButtonProps, SheetHeaderProps } from "./SheetHeader.types";

export function SheetCloseButton(props: SheetCloseButtonProps) {
  return (
    <IconButton
      icon="xmark"
      accessibilityLabel={props.accessibilityLabel ?? (props.onCancel ? "Cancel" : "Close")}
      disabled={props.disabled}
      onPress={props.onCancel ?? props.onClose}
    />
  );
}

export function SheetHeader(props: SheetHeaderProps) {
  return (
    <>
      <SheetDismissGuard dismissDisabled={props.dismissDisabled} />
      {props.presentation !== "inline" ? (
        <NativeSheetHeader {...props} />
      ) : (
        <InlineSheetHeader {...props} />
      )}
    </>
  );
}

/** A sheet that can't be closed with its button can't be swiped away either. */
function SheetDismissGuard(props: { readonly dismissDisabled: boolean | undefined }) {
  return props.dismissDisabled === undefined ? null : (
    <NativeStackScreenOptions options={{ gestureEnabled: !props.dismissDisabled }} />
  );
}

function NativeSheetHeader(props: SheetHeaderProps) {
  const { colors } = useControlTheme();
  const onDismiss = props.onCancel ?? props.onClose;
  const dismissLabel = props.accessibilityLabel ?? (props.onCancel ? "Cancel" : "Close");
  const confirmation = props.confirm;

  // Toolbar children are parsed as native items, so keep the actual Button
  // elements here instead of hiding them behind another component.
  return (
    <>
      <NativeStackScreenOptions
        options={{
          title: props.title,
          headerBackVisible: false,
          unstable_headerSubtitle: props.subtitle,
        }}
      />
      <Toolbar placement="left">
        <Toolbar.Button
          icon="xmark"
          accessibilityLabel={dismissLabel}
          onPress={onDismiss}
          disabled={props.dismissDisabled}
        />
      </Toolbar>
      {confirmation || props.trailing || props.actions?.length || props.menus?.length ? (
        <Toolbar placement="right">
          {props.actions?.map((action) => (
            <Toolbar.Button
              key={action.accessibilityLabel}
              icon={typeof action.icon === "string" ? action.icon : action.icon.ios}
              accessibilityLabel={action.accessibilityLabel}
              disabled={action.disabled || action.loading}
              tintColor={action.tintColor}
              onPress={action.onPress}
            />
          ))}
          {props.menus?.map(createNativeHeaderMenu)}
          {props.trailing ? (
            <Toolbar.Custom>
              <View>{props.trailing}</View>
            </Toolbar.Custom>
          ) : null}
          {confirmation?.loading ? (
            <Toolbar.Custom>
              <View
                className="size-11 items-center justify-center"
                accessible
                accessibilityLabel={confirmation.label}
                accessibilityState={{ busy: true }}
              >
                <AppActivityIndicator colorClassName="accent-prominent-action" />
              </View>
            </Toolbar.Custom>
          ) : confirmation ? (
            <Toolbar.Button
              icon="checkmark"
              variant="prominent"
              visibilityPriority="high"
              tintColor={colors["--color-prominent-action"]}
              accessibilityLabel={confirmation.label}
              disabled={confirmation.disabled}
              onPress={confirmation.onPress}
            />
          ) : null}
        </Toolbar>
      ) : null}
    </>
  );
}

function InlineConfirmation({
  confirmation,
}: {
  readonly confirmation: NonNullable<SheetHeaderProps["confirm"]>;
}) {
  const confirmDisabled = confirmation.disabled || confirmation.loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={confirmation.label}
      accessibilityState={{
        disabled: Boolean(confirmDisabled),
        busy: Boolean(confirmation.loading),
      }}
      disabled={confirmDisabled}
      onPress={confirmation.onPress}
      className={
        confirmDisabled
          ? "size-11 items-center justify-center rounded-full bg-subtle-strong"
          : "size-11 items-center justify-center rounded-full bg-prominent-action"
      }
    >
      {confirmation.loading ? (
        <AppActivityIndicator colorClassName="accent-icon-subtle" />
      ) : (
        <SymbolView
          name="checkmark"
          size={20}
          tintColorClassName={
            confirmDisabled ? "accent-icon-subtle" : "accent-prominent-action-foreground"
          }
        />
      )}
    </Pressable>
  );
}

function InlineSheetHeader(props: SheetHeaderProps) {
  const close = (
    <SheetCloseButton
      {...(props.onCancel ? { onCancel: props.onCancel } : { onClose: props.onClose })}
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.dismissDisabled}
    />
  );
  const confirm = props.confirm ? <InlineConfirmation confirmation={props.confirm} /> : null;
  const trailing =
    props.trailing || confirm || props.actions?.length ? (
      <View className="flex-row items-center gap-2">
        {props.actions?.map((action) => (
          <IconButton
            key={action.accessibilityLabel}
            icon={action.icon}
            accessibilityLabel={action.accessibilityLabel}
            disabled={action.disabled || action.loading}
            onPress={action.onPress}
          />
        ))}
        {props.trailing}
        {confirm}
      </View>
    ) : undefined;

  return (
    <View className="flex-row items-center gap-3 px-4 pt-3 pb-3">
      {close}
      <View className="min-w-0 flex-1 gap-1">
        <AppText numberOfLines={1} className="text-base font-t3-bold text-foreground">
          {props.title}
        </AppText>
        {props.subtitle ? (
          <AppText
            numberOfLines={1}
            ellipsizeMode="middle"
            className="text-xs text-foreground-muted"
          >
            {props.subtitle}
          </AppText>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}
