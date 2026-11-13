/** Candidate page backgrounds for the nightly channel. The first one is what the site ships. */
export const NIGHTLY_BACKGROUNDS = [
  { id: "sunrise", label: "orbital sunrise" },
  { id: "dim", label: "sunrise, dimmed" },
  { id: "horizon", label: "horizon only" },
  { id: "mono", label: "sunrise, mono" },
  { id: "clouds", label: "night clouds" },
] as const;

export const NIGHTLY_BACKGROUND_STORAGE_KEY = "t3code-nightly-bg";
