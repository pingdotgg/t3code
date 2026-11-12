import { createContext } from "react";

/**
 * True for a thread kept mounted under Settings or Usage, or shown as a side chat in its
 * parent's panel; its global shortcuts and listeners stand down.
 */
export const BackgroundThreadContext = createContext(false);

/**
 * True while a background thread is also out of sight, as under Pull requests. Work that only
 * serves someone watching it, such as live previews and visit tracking, waits until it shows.
 */
export const HiddenThreadContext = createContext(false);
