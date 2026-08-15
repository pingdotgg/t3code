export interface ComposerUploadFile {
  readonly name: string;
  readonly type: string;
}

export interface ComposerFileUploadOptions<TFile> {
  readonly allowLocalPaths: boolean;
  readonly getPathForFile?: ((file: TFile) => string) | undefined;
}

export function prepareComposerFileUpload<TFile extends ComposerUploadFile>(
  files: ReadonlyArray<TFile>,
  options: ComposerFileUploadOptions<TFile>,
): {
  readonly imageFiles: TFile[];
  readonly paths: string[];
  readonly unresolvedNames: string[];
  readonly unsupportedNames: string[];
} {
  const imageFiles = files.filter((file) => file.type.startsWith("image/"));
  const otherFiles = files.filter((file) => !file.type.startsWith("image/"));
  if (!options.allowLocalPaths) {
    return {
      imageFiles,
      paths: [],
      unresolvedNames: [],
      unsupportedNames: options.getPathForFile ? otherFiles.map((file) => file.name) : [],
    };
  }
  if (!options.getPathForFile) {
    return { imageFiles, paths: [], unresolvedNames: [], unsupportedNames: [] };
  }
  const paths: string[] = [];
  const unresolvedNames: string[] = [];

  for (const file of otherFiles) {
    let path = "";
    try {
      path = options.getPathForFile(file).trim();
    } catch {
      path = "";
    }
    if (path) {
      paths.push(path);
    } else {
      unresolvedNames.push(file.name);
    }
  }

  return { imageFiles, paths, unresolvedNames, unsupportedNames: [] };
}
