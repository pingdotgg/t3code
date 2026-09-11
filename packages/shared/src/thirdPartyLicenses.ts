export interface ThirdPartyLicenseEntry {
  readonly bundles: ReadonlyArray<string>;
  readonly kind: "custom" | "package";
  readonly license: string;
  readonly name: string;
  readonly noticeText: string;
  readonly sourceUrl: string | null;
  readonly version: string | null;
}

export interface ThirdPartyLicenseManifest {
  readonly schemaVersion: 1;
  readonly entries: ReadonlyArray<ThirdPartyLicenseEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function decodeEntry(value: unknown, index: number): ThirdPartyLicenseEntry {
  if (!isRecord(value)) {
    throw new Error(`License entry ${String(index + 1)} is not an object.`);
  }
  if (
    !isStringArray(value.bundles) ||
    value.bundles.length === 0 ||
    (value.kind !== "custom" && value.kind !== "package") ||
    typeof value.license !== "string" ||
    typeof value.name !== "string" ||
    typeof value.noticeText !== "string" ||
    (value.sourceUrl !== null && !isHttpUrl(value.sourceUrl)) ||
    (value.version !== null && typeof value.version !== "string")
  ) {
    throw new Error(`License entry ${String(index + 1)} has an invalid shape.`);
  }
  return {
    bundles: value.bundles,
    kind: value.kind,
    license: value.license,
    name: value.name,
    noticeText: value.noticeText,
    sourceUrl: value.sourceUrl,
    version: value.version,
  };
}

export function decodeThirdPartyLicenseManifest(value: unknown): ThirdPartyLicenseManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
    throw new Error("The open-source license manifest has an unsupported format.");
  }
  const entries = value.entries.map(decodeEntry);
  const entryKeys = new Set<string>();
  for (const entry of entries) {
    const key = thirdPartyLicenseEntryKey(entry);
    if (entryKeys.has(key)) {
      throw new Error(`The open-source license manifest contains a duplicate entry: ${key}`);
    }
    entryKeys.add(key);
  }
  return {
    schemaVersion: 1,
    entries,
  };
}

export function filterThirdPartyLicenseEntries(
  entries: ReadonlyArray<ThirdPartyLicenseEntry>,
  query: string,
): ReadonlyArray<ThirdPartyLicenseEntry> {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return entries;
  return entries.filter((entry) => {
    const searchable = [entry.name, entry.version, entry.license, ...entry.bundles]
      .filter((value): value is string => value !== null)
      .join(" ")
      .toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

const BUNDLE_LABELS: Readonly<Record<string, string>> = {
  android: "Android",
  assets: "Assets",
  desktop: "Desktop",
  "device-tools": "Device tools",
  ios: "iOS",
  mobile: "Mobile",
  server: "Server",
  web: "Web",
};

export function formatLicenseBundles(bundles: ReadonlyArray<string>): string {
  return bundles.map((bundle) => BUNDLE_LABELS[bundle] ?? bundle).join(", ");
}

export function thirdPartyLicenseEntryKey(entry: ThirdPartyLicenseEntry): string {
  return encodeURIComponent(`${entry.kind}:${entry.name}:${entry.version ?? "custom"}`);
}

export function findThirdPartyLicenseEntry(
  entries: ReadonlyArray<ThirdPartyLicenseEntry>,
  key: string,
): ThirdPartyLicenseEntry | undefined {
  return entries.find((entry) => thirdPartyLicenseEntryKey(entry) === key);
}
