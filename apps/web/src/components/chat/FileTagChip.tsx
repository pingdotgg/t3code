import { inferEntryKindFromPath } from "../../pierre-icons";
import { ContextChipLabel } from "../ContextChip";
import { PierreEntryIcon } from "./PierreEntryIcon";

/** Icon and label for a file mention; render inside `<ContextChip kind="mention">`. */
export function FileTagChipContent(props: {
  path: string;
  label: string;
  theme: "light" | "dark";
}) {
  return (
    <>
      <PierreEntryIcon
        pathValue={props.path}
        kind={inferEntryKindFromPath(props.path)}
        theme={props.theme}
      />
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </>
  );
}
