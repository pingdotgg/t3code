import { createContext } from "react";
import type { VerticalHinge } from "../lib/layout";

/** A creased vertical hinge in window coordinates, for overlays placed in window space. */
export const WindowHingeContext = createContext<VerticalHinge | null>(null);
