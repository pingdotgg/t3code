import { defineProviderClient } from "@t3tools/provider-core/client";
import { OMP_RPC_PROVIDER, OmpRpcSettings } from "./settings.ts";

export const ompRpcClient = defineProviderClient({
  driverKind: OMP_RPC_PROVIDER,
  label: "Oh My Pi",
  settingsSchema: OmpRpcSettings,
  icon: {
    viewBox: "0 0 64 64",
    fill: { light: "#9b4dff", dark: "#9b4dff" },
    paths: [
      // https://omp.sh/favicon.svg
      {
        d: "M12 0H52A12 12 0 0 1 64 12V52A12 12 0 0 1 52 64H12A12 12 0 0 1 0 52V12A12 12 0 0 1 12 0Z",
        fill: { light: "#0f0a14", dark: "#0f0a14" },
      },
      {
        d: "M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z",
        gradient: {
          x1: 14,
          y1: 16,
          x2: 50,
          y2: 56,
          stops: [
            { offset: 0, color: "#ed4abf" },
            { offset: 0.5, color: "#9b4dff" },
            { offset: 1, color: "#5ad8e6" },
          ],
        },
      },
    ],
  },
});
