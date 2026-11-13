import { createContext } from "react";

/** True inside a draggable bottom sheet, which owns the downward drag at the top of its content. */
export const BottomSheetContext = createContext(false);
