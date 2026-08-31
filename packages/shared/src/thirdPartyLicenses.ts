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
    (value.sourceUrl !== null && typeof value.sourceUrl !== "string") ||
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
  return {
    schemaVersion: 1,
    entries: value.entries.map(decodeEntry),
  };
}

export function filterThirdPartyLicenseEntries(
  entries: ReadonlyArray<ThirdPartyLicenseEntry>,
  query: string,
): ReadonlyArray<ThirdPartyLicenseEntry> {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return entries;
  return entries.filter((entry) => {
    const searchable = [entry.name, entry.version, entry.license, ...entry.bundles]
      .filter((value): value is string => value !== null)
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

const BUNDLE_LABELS: Readonly<Record<string, string>> = {
  android: "Android",
  assets: "Assets",
  desktop: "Desktop",
  ios: "iOS",
  mobile: "Mobile",
  server: "Server",
  web: "Web",
};

export function formatLicenseBundles(bundles: ReadonlyArray<string>): string {
  return bundles.map((bundle) => BUNDLE_LABELS[bundle] ?? bundle).join(", ");
}

export function thirdPartyLicenseEntryKey(entry: ThirdPartyLicenseEntry): string {
  return `${entry.kind}:${entry.name}:${entry.version ?? "custom"}`;
}

export function findThirdPartyLicenseEntry(
  entries: ReadonlyArray<ThirdPartyLicenseEntry>,
  key: string,
): ThirdPartyLicenseEntry | undefined {
  return entries.find((entry) => thirdPartyLicenseEntryKey(entry) === key);
}
