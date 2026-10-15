import { Toolbar } from "./Toolbar";

export const ScreenHeaderButton: (
  props: Parameters<typeof Toolbar.Button>[0] & { readonly selected?: boolean },
) => ReturnType<typeof Toolbar.Button> = Toolbar.Button;
