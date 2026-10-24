import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { CommandCodeSettings } from "./settings.ts";

export const commandCodeClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("commandCode"),
  label: "Command Code",
  settingsSchema: CommandCodeSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        d: "M4 5.5C4 4.67157 4.67157 4 5.5 4H18.5C19.3284 4 20 4.67157 20 5.5V18.5C20 19.3284 19.3284 20 18.5 20H5.5C4.67157 20 4 19.3284 4 18.5V5.5ZM7.29289 8.29289C6.90237 8.68342 6.90237 9.31658 7.29289 9.70711L9.58579 12L7.29289 14.2929C6.90237 14.6834 6.90237 15.3166 7.29289 15.7071C7.68342 16.0976 8.31658 16.0976 8.70711 15.7071L11.7071 12.7071C12.0976 12.3166 12.0976 11.6834 11.7071 11.2929L8.70711 8.29289C8.31658 7.90237 7.68342 7.90237 7.29289 8.29289ZM13 14C12.4477 14 12 14.4477 12 15C12 15.5523 12.4477 16 13 16H16C16.5523 16 17 15.5523 17 15C17 14.4477 16.5523 14 16 14H13Z",
      },
    ],
  },
});
