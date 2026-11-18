import { createContext } from "react";

export interface GeneratedImageReadiness {
  readonly paths: ReadonlySet<string>;
  readonly onSettled: (path: string) => void;
}

export const GeneratedImageSettledContext = createContext<GeneratedImageReadiness | null>(null);
