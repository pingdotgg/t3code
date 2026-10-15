import type { ComponentProps } from "react";
import type { SymbolView } from "./AppSymbol";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

export interface SliderRowProps {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly minimumIcon?: SymbolName;
  readonly maximumIcon?: SymbolName;
  readonly label: string;
  readonly valueLabel: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly onChange: (value: number) => void;
}
