export function shouldOpenProjectFolderPickerImmediately(input: {
  isElectron: boolean;
  isMobile: boolean;
}): boolean {
  return input.isElectron && !input.isMobile;
}
