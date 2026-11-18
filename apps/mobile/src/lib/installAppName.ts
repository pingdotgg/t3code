// Conn: names the app for `{appName}` copy before any screen module builds a message.
import { setAppName } from "@t3tools/shared/appName";
import Constants from "expo-constants";

import { resolveBrandName } from "./mobileBranding";

setAppName(resolveBrandName(Constants.expoConfig?.extra?.brandName));
