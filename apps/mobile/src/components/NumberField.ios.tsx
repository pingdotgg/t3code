import { Button, Host, HStack, Picker, Popover, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonStyle,
  disabled,
  font,
  foregroundStyle,
  frame,
  padding,
  pickerStyle,
  presentationBackground,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";

import { useControlTheme } from "./useControlTheme";
import type { NumberFieldProps } from "./NumberField";

export function NumberField(props: NumberFieldProps) {
  const { colorScheme, colors, fontSize } = useControlTheme();
  const values = Array.from({ length: props.max - props.min + 1 }, (_, index) => props.min + index);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(props.value);
  return (
    <Host matchContents colorScheme={colorScheme} seedColor={colors["--color-primary"]}>
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
            <HStack spacing={24}>
              <Button
                label="Cancel"
                onPress={() => setOpen(false)}
                modifiers={[foregroundStyle(colors["--color-primary-text"])]}
              />
              <Button
                label="Done"
                onPress={() => {
                  setOpen(false);
                  if (!props.disabled && draft !== props.value) props.onValueChange(draft);
                }}
                modifiers={[foregroundStyle(colors["--color-primary-text"])]}
              />
            </HStack>
          </VStack>
        </Popover.Content>
      </Popover>
    </Host>
  );
}
