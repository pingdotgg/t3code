import type { SourceControlIcon } from "@t3tools/source-control-core/client/definition";

// The view box starts at -6 to move the mark 6 units in, as the published artwork's group does.
export const icon: SourceControlIcon = {
  viewBox: "-6 -6 212 212",
  paths: [
    { d: "M58 168 v-98 a50 50 0 0 1 50-50 h20", stroke: "#ff6600", strokeWidth: 25 },
    { d: "M58 168 v-30 a50 50 0 0 1 50-50 h20", stroke: "#d40000", strokeWidth: 25 },
    { d: "M124 20 a18 18 0 1 0 36 0 a18 18 0 1 0 -36 0z", stroke: "#ff6600", strokeWidth: 15 },
    { d: "M124 88 a18 18 0 1 0 36 0 a18 18 0 1 0 -36 0z", stroke: "#d40000", strokeWidth: 15 },
    { d: "M40 180 a18 18 0 1 0 36 0 a18 18 0 1 0 -36 0z", stroke: "#d40000", strokeWidth: 15 },
  ],
};
