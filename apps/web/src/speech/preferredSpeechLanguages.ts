// Packaged desktop pins `navigator.languages` to en-US, so the OS's own list leads.
export const preferredSpeechLanguages = () =>
  [...(window.desktopBridge?.getPreferredSystemLanguages() ?? []), ...navigator.languages].map(
    (tag) => tag.toLowerCase().split(/[-_]/)[0]!,
  );
