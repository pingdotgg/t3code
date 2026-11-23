import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable } from "react-native";

import { AppText } from "./AppText";
import { ListRowLayout, type ListRowContentProps } from "./ListRowLayout";
import { ThemedSwitch } from "./ThemedSwitch";

/**
 * A mixed row flips the value last picked on it, so a pick that some environments dropped can be
 * undone. Before any pick, it sets the value on everywhere.
 */
export function ListToggleRow(
  props: Omit<ListRowContentProps, "detail"> & {
    readonly value: boolean | null;
    readonly onValueChange: (value: boolean) => void;
  },
) {
  const gt = useGT();
  const [picked, setPicked] = useState(false);
  const pick = (value: boolean) => {
    setPicked(value);
    props.onValueChange(value);
  };
  return (
    <ListRowLayout
      icon={props.icon}
      label={props.label}
      description={props.description}
      disabled={props.disabled}
      accessory={
        props.value === null ? (
          <Pressable
            accessibilityLabel={
              picked
                ? gt("Set {label} off for selected environments", { label: props.label })
                : gt("Set {label} on for selected environments", { label: props.label })
            }
            accessibilityRole="button"
            accessibilityHint={props.description}
            accessibilityState={{ disabled: Boolean(props.disabled) }}
            disabled={props.disabled}
            className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
            onPress={() => pick(!picked)}
          >
            <AppText className="text-sm font-t3-medium text-foreground">
              {picked ? <T>Mixed · Set off</T> : <T>Mixed · Set on</T>}
            </AppText>
          </Pressable>
        ) : (
          <ThemedSwitch
            accessibilityLabel={props.label}
            accessibilityHint={props.description}
            disabled={props.disabled}
            style={{ alignSelf: "center" }}
            onValueChange={pick}
            value={props.value}
          />
        )
      }
    />
  );
}
