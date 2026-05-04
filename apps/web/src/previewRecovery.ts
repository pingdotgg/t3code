export function isDynamicImportFetchErrorMessage(message: string): boolean {
  return message.toLowerCase().includes("failed to fetch dynamically imported module");
}
