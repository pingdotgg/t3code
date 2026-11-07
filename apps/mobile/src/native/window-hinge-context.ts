import { createContext } from "react";
import type { VerticalHinge } from "../lib/layout";

/**
 * A creased vertical hinge in window coordinates, for overlays placed in window space.
 * `panesSettled` counts finished workspace pane animations. Panes move what an overlay is
 * anchored to, such as a sidebar button when the hinge resizes the list.
 */
export const WindowHingeContext = createContext<{
  readonly hinge: VerticalHinge | null;
  readonly panesSettled: number;
}>({ hinge: null, panesSettled: 0 });
