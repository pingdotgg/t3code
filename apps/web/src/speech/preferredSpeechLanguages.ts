// Packaged desktop builds report only en-US in navigator.languages, so the OS languages lead.
export const preferredSpeechLanguages = () =>
  [...(window.desktopBridge?.getPreferredSystemLanguages() ?? []), ...navigator.languages].map(
    (tag) => tag.toLowerCase().split(/[-_.@]/)[0]!,
  );
