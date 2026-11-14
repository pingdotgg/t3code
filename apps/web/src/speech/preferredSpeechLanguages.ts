// Packaged desktop pins `navigator.languages` to en-US, so the OS's own list leads.
export function preferredSpeechLanguages() {
  const bridge = window.desktopBridge;
  let system = bridge?.getPreferredSystemLanguages?.() ?? [];
  if (!system.length) {
    const locale = bridge?.getSystemLocale?.();
    if (locale) system = [locale];
  }
  return [...system, ...navigator.languages].map((tag) => tag.toLowerCase().split(/[-_]/)[0]!);
}
