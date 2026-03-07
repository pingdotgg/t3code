import vscodeIconsManifest from "./vscode-icons-manifest.json";
import languageAssociationsData from "./vscode-icons-language-associations.json";

const VSCODE_ICONS_VERSION = "v12.17.0";
const VSCODE_ICONS_BASE_URL = `https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons@${VSCODE_ICONS_VERSION}/icons`;

interface IconDefinition {
  iconPath: string;
}

interface IconLookupSection {
  file?: string;
  folder?: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  languageIds?: Record<string, string>;
}

interface VscodeIconsManifest extends IconLookupSection {
  iconDefinitions: Record<string, IconDefinition>;
  light: IconLookupSection;
}

interface LanguageAssociations {
  version: string;
  extensionToLanguageId: Record<string, string>;
  fileNameToLanguageId: Record<string, string>;
}

const manifest = vscodeIconsManifest as VscodeIconsManifest;
const languageAssociations = languageAssociationsData as LanguageAssociations;
const iconDefinitions = manifest.iconDefinitions;

const darkFileNames = toLowercaseLookup(manifest.fileNames);
const lightFileNames = toLowercaseLookup(manifest.light.fileNames);
const darkFileExtensions = toLowercaseLookup(manifest.fileExtensions);
const lightFileExtensions = toLowercaseLookup(manifest.light.fileExtensions);
const darkFolderNames = toLowercaseLookup(manifest.folderNames);
const lightFolderNames = toLowercaseLookup(manifest.light.folderNames);
const darkLanguageIds = toLowercaseLookup(manifest.languageIds ?? {});
const lightLanguageIds = toLowercaseLookup(manifest.light.languageIds ?? {});
const languageIdByExtension = toLowercaseLookup(languageAssociations.extensionToLanguageId);
const languageIdByFileName = toLowercaseLookup(languageAssociations.fileNameToLanguageId);
const localLanguageIdByExtensionOverrides = {
  // Cursor rules files (*.mdc) are commonly treated as markdown in VSCode/Cursor.
  mdc: "markdown",
  // Upstream languages.ts currently maps .html to django-html before html.
  // Prefer the base HTML icon for standalone HTML files.
  html: "html",
  // Upstream languages.ts maps yml/yaml to specialized language ids that can produce
  // non-generic YAML icons (for example cloudfoundry/esphome). Prefer the base YAML icon
  // unless a more specific basename/extension match (e.g. azure-pipelines.yml) is found.
  yml: "yaml",
  yaml: "yaml",
} as const;

const defaultDarkFileIconDefinition = manifest.file ?? "_file";
const defaultLightFileIconDefinition = manifest.light.file ?? defaultDarkFileIconDefinition;
const defaultDarkFolderIconDefinition = manifest.folder ?? "_folder";
const defaultLightFolderIconDefinition = manifest.light.folder ?? defaultDarkFolderIconDefinition;

function toLowercaseLookup(source: Record<string, string>): Record<string, string> {
  const entries = Object.entries(source);
  const lookup: Record<string, string> = {};
  for (const [key, value] of entries) {
    lookup[key.toLowerCase()] = value;
  }
  return lookup;
}

export function basenameOfPath(pathValue: string): string {
  const slashIndex = pathValue.lastIndexOf("/");
  if (slashIndex === -1) return pathValue;
  return pathValue.slice(slashIndex + 1);
}

function extensionCandidates(fileName: string): string[] {
  const candidates = new Set<string>();
  if (fileName.includes(".")) {
    candidates.add(fileName);
  }
  let dotIndex = fileName.indexOf(".");
  while (dotIndex !== -1 && dotIndex < fileName.length - 1) {
    const candidate = fileName.slice(dotIndex + 1);
    if (candidate.length > 0) {
      candidates.add(candidate);
    }
    dotIndex = fileName.indexOf(".", dotIndex + 1);
  }
  return [...candidates];
}

function resolveLanguageFallbackDefinition(
  pathValue: string,
  theme: "light" | "dark",
): string | null {
  const basename = basenameOfPath(pathValue).toLowerCase();
  const languageIds = theme === "light" ? lightLanguageIds : darkLanguageIds;

  const fromBasenameLanguage = languageIdByFileName[basename];
  if (fromBasenameLanguage) {
    return languageIds[fromBasenameLanguage] ?? darkLanguageIds[fromBasenameLanguage] ?? null;
  }

  for (const candidate of extensionCandidates(basename)) {
    const languageId =
      localLanguageIdByExtensionOverrides[
        candidate as keyof typeof localLanguageIdByExtensionOverrides
      ] ?? languageIdByExtension[candidate];
    if (!languageId) continue;
    return languageIds[languageId] ?? darkLanguageIds[languageId] ?? null;
  }

  return null;
}

function iconFilenameForDefinitionKey(definitionKey: string | undefined): string | null {
  if (!definitionKey) return null;
  const iconPath = iconDefinitions[definitionKey]?.iconPath;
  if (!iconPath) return null;
  const slashIndex = iconPath.lastIndexOf("/");
  if (slashIndex === -1) {
    return iconPath;
  }
  return iconPath.slice(slashIndex + 1);
}

function resolveFileDefinition(pathValue: string, theme: "light" | "dark"): string {
  const basename = basenameOfPath(pathValue).toLowerCase();
  const fileNames = theme === "light" ? lightFileNames : darkFileNames;
  const fileExtensions = theme === "light" ? lightFileExtensions : darkFileExtensions;

  const fromFileName = fileNames[basename] ?? darkFileNames[basename];
  if (fromFileName) return fromFileName;

  for (const candidate of extensionCandidates(basename)) {
    const fromExtension = fileExtensions[candidate] ?? darkFileExtensions[candidate];
    if (fromExtension) return fromExtension;
  }

  const fromLanguage = resolveLanguageFallbackDefinition(pathValue, theme);
  if (fromLanguage) return fromLanguage;

  return theme === "light" ? defaultLightFileIconDefinition : defaultDarkFileIconDefinition;
}

function resolveFolderDefinition(pathValue: string, theme: "light" | "dark"): string {
  const basename = basenameOfPath(pathValue).toLowerCase();
  const folderNames = theme === "light" ? lightFolderNames : darkFolderNames;
  return (
    folderNames[basename] ??
    darkFolderNames[basename] ??
    (theme === "light" ? defaultLightFolderIconDefinition : defaultDarkFolderIconDefinition)
  );
}

export function getVscodeIconUrlForEntry(
  pathValue: string,
  kind: "file" | "directory",
  theme: "light" | "dark",
): string {
  const definitionKey =
    kind === "directory"
      ? resolveFolderDefinition(pathValue, theme)
      : resolveFileDefinition(pathValue, theme);
  const iconFilename =
    iconFilenameForDefinitionKey(definitionKey) ??
    (kind === "directory" ? "default_folder.svg" : "default_file.svg");
  return `${VSCODE_ICONS_BASE_URL}/${iconFilename}`;
}
