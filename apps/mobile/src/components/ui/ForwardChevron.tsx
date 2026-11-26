import type { ComponentProps } from "react";

import { useForwardChevron } from "../../i18n/direction";
import { SymbolView } from "./AppSymbol";

export function ForwardChevron(props: Omit<ComponentProps<typeof SymbolView>, "name">) {
  return <SymbolView {...props} name={useForwardChevron()} />;
}
