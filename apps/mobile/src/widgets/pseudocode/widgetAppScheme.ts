import * as Linking from "expo-linking";

export function widgetAppScheme() {
  return Linking.createURL("/").split(":")[0] ?? "t3code";
}
