import { shareAsync, type SharingOptions } from "expo-sharing";

export function shareFileFromSource(
  uri: string,
  options: SharingOptions,
  _sourceIdentifier: string,
) {
  return shareAsync(uri, options);
}
