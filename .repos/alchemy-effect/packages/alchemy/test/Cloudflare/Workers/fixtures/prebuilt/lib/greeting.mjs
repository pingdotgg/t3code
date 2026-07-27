import notice from "./notice.txt";
import { exclaim } from "./format.mjs";

export const greeting = exclaim(
  `prebuilt-modules-survived ${notice.trim()}`,
);
