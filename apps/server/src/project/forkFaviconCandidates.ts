// Fork-only: SvelteKit icon spots, at the root or one app folder down. Kept out of
// ProjectFaviconResolver.ts so upstream merges touch only its one-line hook.
const SVELTEKIT_ICONS = [
  "static/favicon.svg",
  "static/favicon.png",
  "static/favicon.ico",
  "src/lib/assets/favicon.svg",
  "src/lib/assets/favicon.png",
];
const APP_FOLDERS = ["", "web/", "website/", "app/", "app-web/", "frontend/"];

export const FORK_FAVICON_CANDIDATES = APP_FOLDERS.flatMap((folder) =>
  SVELTEKIT_ICONS.map((icon) => folder + icon),
);
