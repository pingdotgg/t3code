import { createContext } from "react";

/**
 * True for a thread kept mounted under Settings or Usage, or shown as a side chat in its
 * parent's panel; its global shortcuts and listeners stand down.
 */
export const BackgroundThreadContext = createContext(false);

/** True only for a thread kept mounted out of sight under Settings or Usage. */
export const HiddenThreadContext = createContext(false);
