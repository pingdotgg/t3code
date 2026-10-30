import { Button, HStack, Picker, Popover, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  disabled,
  font,
  foregroundStyle,
  frame,
  labelStyle,
  padding,
  pickerStyle,
  presentationBackground,
  tag,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";

import { NativeThemeHost } from "./NativeThemeHost";
import { useControlTheme } from "./useControlTheme";
import type { NumberFieldProps } from "./NumberField.types";

export function NumberField(props: NumberFieldProps) {
  const { colors, fontSize } = useControlTheme();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(props.value);
  const values = Array.from({ length: props.max - props.min + 1 }, (_, index) => props.min + index);
  if (!values.includes(draft)) values.push(draft);
  values.sort((a, b) => a - b);
  return (
    <NativeThemeHost matchContents>
      <Popover isPresented={open} onIsPresentedChange={setOpen}>
        <Popover.Trigger>
          <Button
            onPress={() => {
              if (props.disabled) return;
              setDraft(props.value);
              setOpen(true);
            }}
            modifiers={[
              buttonStyle("bordered"),
              disabled(props.disabled),
              accessibilityLabel(
                `${props.label}: ${props.formatValue?.(props.value) ?? props.value}`,
              ),
              frame({ minWidth: 64, minHeight: 44 }),
              foregroundStyle(colors["--color-primary-text"]),
              font({ size: fontSize }),
            ]}
          >
            <Text>{String(props.value)}</Text>
          </Button>
        </Popover.Trigger>
        <Popover.Content>
          <VStack
            modifiers={[
              padding({ all: 12 }),
              frame({ width: 240 }),
              presentationBackground(colors["--color-sheet-solid"]),
            ]}
          >
            <Picker
              label={props.label}
              selection={draft}
              onSelectionChange={setDraft}
              modifiers={[pickerStyle("wheel"), frame({ height: 180 })]}
            >
              {values.map((value) => (
                <Text
                  key={value}
                  modifiers={[tag(value), foregroundStyle(colors["--color-foreground"])]}
                >
                  {props.formatValue?.(value) ?? String(value)}
                </Text>
              ))}
            </Picker>
            <HStack>
              <Button
                label="Cancel"
                systemImage="xmark"
                onPress={() => setOpen(false)}
                modifiers={[
                  labelStyle("iconOnly"),
                  buttonStyle("bordered"),
                  buttonBorderShape("circle"),
                  tint(colors["--color-foreground"]),
                ]}
              />
              <Spacer />
              <Button
                label="Done"
                systemImage="checkmark"
                onPress={() => {
                  setOpen(false);
                  if (!props.disabled && draft !== props.value) props.onValueChange(draft);
                }}
                modifiers={[
                  labelStyle("iconOnly"),
                  buttonStyle("borderedProminent"),
                  buttonBorderShape("circle"),
                  tint(colors["--color-prominent-action"]),
                  foregroundStyle(colors["--color-prominent-action-foreground"]),
                ]}
              />
            </HStack>
          </VStack>
        </Popover.Content>
      </Popover>
    </NativeThemeHost>
  );
}

export type { NumberFieldProps } from "./NumberField.types";
