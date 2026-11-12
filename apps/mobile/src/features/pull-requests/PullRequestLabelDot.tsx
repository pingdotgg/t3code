import { View } from "react-native";

/** A label's color mark in pickers; uncolored labels keep its room so names line up. */
export function PullRequestLabelDot(props: { readonly color: string | null }) {
  return (
    <View
      className="size-2.5 rounded-full"
      style={{ backgroundColor: props.color ?? "transparent" }}
    />
  );
}
