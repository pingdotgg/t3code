import { NativeHeaderToolbar } from "../native/StackHeader";
export const ScreenHeaderButton: (
  props: Parameters<typeof NativeHeaderToolbar.Button>[0] & { readonly selected?: boolean },
) => ReturnType<typeof NativeHeaderToolbar.Button> = NativeHeaderToolbar.Button;
