import { createContext } from "react";

/** Width a header's own buttons and margins take beside a custom title, which RN sizes itself. */
export const HeaderItemsWidthContext = createContext<number | null>(null);
