import { createContext } from "react";

/** The text a block renders and whether it is still growing, which a fence needs to know if it is closed. */
export const BlockContext = createContext({ text: "", streaming: false });
