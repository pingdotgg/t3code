// @effect-diagnostics nodeBuiltinImport:off - a dev script, not Effect code.
// Mobile lab themes: the phone wears Nick's appearance, like the desktop lab does.
//
// Nick's Orbit profile "Nick" has the custom dark theme "Dark Mono" in the dark slot, stock t3-code
// for light, and dark mode on. The desktop lab seeds Dark Mono from apps/web/lab.html; this file
// reads the same palette from there, so the two labs cannot drift. The lab server publishes the
// theme files (`<stateDir>/themes/<id>.json`), the phone lists them as `published:<id>` themes, and
// `applyLabTheme` writes the phone's theme preferences, which live in the app's SQLite database.
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import * as VM from "node:vm";

export const LAB_THEMES = ["dark-mono", "dark-ocean", "ocean", "stock", "light"] as const;
export type LabTheme = (typeof LAB_THEMES)[number];
export const DEFAULT_LAB_THEME: LabTheme = "dark-mono";

const DARK_MONO_ID = "dark-mono";
const DARK_OCEAN_ID = "dark-ocean";

/** The palette desktop's lab seeds into `t3code:themes:v1` (the one source for Dark Mono). */
function darkMonoFromDesktopLab(repoRoot: string) {
  const html = FS.readFileSync(Path.join(repoRoot, "apps/web/lab.html"), "utf8");
  // The call is formatted across lines, with or without trailing commas.
  const seeded =
    /setItem\(\s*"t3code:themes:v1",\s*JSON\.stringify\(\s*(\[.*?\])\s*,?\s*\)\s*,?\s*\)/s.exec(
      html,
    )?.[1];
  if (seeded === undefined) throw new Error("apps/web/lab.html no longer seeds t3code:themes:v1.");
  // A JS array literal in the page (unquoted keys), not JSON; it holds only data.
  const themes = VM.runInNewContext(`(${seeded})`) as Array<{
    id: string;
    label: string;
    appearance: string;
    colors: object;
  }>;
  const theme = themes.find((entry) => entry.id === DARK_MONO_ID);
  if (theme === undefined) throw new Error("apps/web/lab.html seeds no Dark Mono theme.");
  return { version: 1, name: theme.label, appearance: theme.appearance, colors: theme.colors };
}

/** Dark Ocean is Nick's tinted sibling (hue 250); desktop dev keeps it under ~/.t3/dev/themes. */
function darkOceanFromDesktopDev() {
  const file = Path.join(OS.homedir(), ".t3/dev/themes", `${DARK_OCEAN_ID}.json`);
  return FS.existsSync(file) ? (JSON.parse(FS.readFileSync(file, "utf8")) as object) : null;
}

/** Writes the theme files the lab server publishes. The server watches the folder, so no restart. */
export function publishLabThemes(home: string, repoRoot: string) {
  const dir = Path.join(home, "userdata", "themes");
  FS.mkdirSync(dir, { recursive: true });
  const write = (id: string, theme: object) =>
    FS.writeFileSync(Path.join(dir, `${id}.json`), `${JSON.stringify(theme, null, 2)}\n`);
  write(DARK_MONO_ID, darkMonoFromDesktopLab(repoRoot));
  const ocean = darkOceanFromDesktopDev();
  if (ocean) write(DARK_OCEAN_ID, ocean);
}

/** Theme preferences for a lab theme. Light always uses stock t3-code, as Nick's profile does. */
function themePreferences(theme: LabTheme) {
  const stock = "t3-code";
  const dark = (id: string) => ({
    themeMode: "dark",
    themeId: id,
    lightThemeId: stock,
    darkThemeId: id,
  });
  switch (theme) {
    case "dark-mono":
      return dark(`published:${DARK_MONO_ID}`);
    case "dark-ocean":
      return dark(`published:${DARK_OCEAN_ID}`);
    case "ocean":
      return dark("ocean");
    case "stock":
      return dark(stock);
    case "light":
      return {
        themeMode: "light",
        themeId: stock,
        lightThemeId: stock,
        darkThemeId: `published:${DARK_MONO_ID}`,
      };
  }
}

export function isLabTheme(value: string | null | undefined): value is LabTheme {
  return (LAB_THEMES as readonly string[]).includes(value ?? "");
}

/**
 * Writes the theme preferences into the app's database. The app must be closed: it reads them at
 * launch. With `onlyIfUnset`, a phone that already has a theme choice keeps it.
 */
export function applyLabTheme(
  database: string,
  theme: LabTheme,
  options: { onlyIfUnset?: boolean } = {},
) {
  const read = ChildProcess.spawnSync(
    "sqlite3",
    [database, "select payload from client_preferences"],
    {
      encoding: "utf8",
    },
  );
  const payload =
    read.stdout.trim() === "" ? {} : (JSON.parse(read.stdout) as Record<string, unknown>);
  const chosen = ["themeMode", "themeId", "lightThemeId", "darkThemeId"].some(
    (key) => key in payload,
  );
  if (options.onlyIfUnset && chosen) return false;
  const next = JSON.stringify({ ...payload, ...themePreferences(theme) }).replaceAll("'", "''");
  const write = ChildProcess.spawnSync(
    "sqlite3",
    [
      database,
      `insert into client_preferences (singleton, payload, updated_at) values (1, '${next}', ${Date.now()})
       on conflict (singleton) do update set payload = excluded.payload, updated_at = excluded.updated_at;
       pragma wal_checkpoint(truncate);`,
    ],
    { encoding: "utf8" },
  );
  if (write.status !== 0) throw new Error(`Could not write the theme preferences: ${write.stderr}`);
  return true;
}
