import { loadFont as loadCaveat } from "@remotion/google-fonts/Caveat";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadJetBrainsMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSourceSerif } from "@remotion/google-fonts/SourceSerif4";

/** The website's type stack (website/src/styles/tokens.css). */
export const sans = loadInter("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
}).fontFamily;
export const mono = loadJetBrainsMono("normal", {
  weights: ["400", "500", "700"],
  subsets: ["latin"],
}).fontFamily;
export const serif = loadSourceSerif("normal", {
  weights: ["400", "600"],
  subsets: ["latin"],
}).fontFamily;

/** Hand-drawn annotations on code. */
export const hand = loadCaveat("normal", {
  weights: ["600", "700"],
  subsets: ["latin"],
}).fontFamily;
