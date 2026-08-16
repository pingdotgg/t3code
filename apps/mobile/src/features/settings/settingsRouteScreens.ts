import { createNativeStackScreen } from "@react-navigation/native-stack";

import { ArchivedThreadsRouteScreen } from "../archive/ArchivedThreadsRouteScreen";
import { SettingsAuthRouteScreen } from "./SettingsAuthRouteScreen";
import {
  SETTINGS_ARCHIVE_ROUTE_CONTRACT,
  SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT,
} from "./settingsContract";

export const SETTINGS_CUSTOM_ROUTE_SCREENS_BY_STACK = {
  content: {
    [SETTINGS_ARCHIVE_ROUTE_CONTRACT.name]: createNativeStackScreen({
      screen: ArchivedThreadsRouteScreen,
      linking: SETTINGS_ARCHIVE_ROUTE_CONTRACT.linking,
      options: {
        title: SETTINGS_ARCHIVE_ROUTE_CONTRACT.title,
      },
    }),
  },
  auth: {
    [SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT.name]: createNativeStackScreen({
      // Keep the old deep link working after the Connect GA launch.
      screen: SettingsAuthRouteScreen,
      linking: SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT.linking,
      options: {
        title: SETTINGS_WAITLIST_ALIAS_ROUTE_CONTRACT.title,
      },
    }),
  },
} as const;
