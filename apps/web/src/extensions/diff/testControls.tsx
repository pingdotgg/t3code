import {
  cloneElement,
  createContext,
  isValidElement,
  use,
  type ReactElement,
  type ReactNode,
} from "react";

export function control(props: {
  children?: ReactNode;
  render?: ReactElement<{ "aria-label"?: string }> | ((...args: never[]) => ReactNode);
  onClick?: () => void;
  onPressedChange?: (pressed: boolean) => void;
  pressed?: boolean;
  "aria-label"?: string;
}) {
  if (isValidElement(props.render))
    return cloneElement(
      props.render,
      props["aria-label"] ? { "aria-label": props["aria-label"] } : {},
      props.children,
    );
  return (
    <button
      onClick={
        props.onClick ??
        (props.onPressedChange ? () => props.onPressedChange?.(!props.pressed) : undefined)
      }
      aria-label={props["aria-label"]}
    >
      {props.children}
    </button>
  );
}

const RadioGroupContext = createContext<((value: string) => void) | undefined>(undefined);

/** Radio menu stand-ins: an item click reports its value to the enclosing group. */
export function radioGroup(props: {
  children?: ReactNode;
  onValueChange?: (value: string) => void;
}) {
  return <RadioGroupContext value={props.onValueChange}>{props.children}</RadioGroupContext>;
}

export function radioItem(props: { children?: ReactNode; value: string }) {
  const onValueChange = use(RadioGroupContext);
  return <button onClick={() => onValueChange?.(props.value)}>{props.children}</button>;
}
