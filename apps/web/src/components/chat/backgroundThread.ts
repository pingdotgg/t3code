import { createContext } from "react";

/** True for a thread kept mounted under Settings or Usage; its global shortcuts stand down. */
export const BackgroundThreadContext = createContext(false);
