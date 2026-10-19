import { Directory, File, Paths } from "expo-file-system";
import * as Font from "expo-font";
import { randomUUID } from "expo-crypto";
import {
  importedFontFamilies,
  importedFontVariant,
  readFontMetadata,
  type ImportedFontFace,
} from "./mobileFonts";

const directory = () => new Directory(Paths.document, "custom-fonts");
const fontFile = (face: ImportedFontFace) => new File(directory(), face.file);

export async function copyImportedFonts(
  assets: readonly { readonly uri: string; readonly name: string }[],
) {
  if (assets.length > 64) throw new Error("Choose up to 64 font files at a time.");
  directory().create({ intermediates: true, idempotent: true });
  const imported: ImportedFontFace[] = [];
  try {
    for (const asset of assets) {
      const extension = /\.(ttf|otf)$/i.exec(asset.name)?.[1]?.toLowerCase();
      if (!extension) throw new Error(`${asset.name}: choose a .ttf or .otf font.`);
      const source = new File(asset.uri);
      if (source.size > 20 * 1024 * 1024)
        throw new Error(`${asset.name}: fonts must be smaller than 20 MB.`);
      const metadata = readFontMetadata(await source.bytes());
      const id = randomUUID();
      const face = { ...metadata, id, file: `${id}.${extension}` };
      imported.push(face);
      source.copy(fontFile(face));
    }
    return imported;
  } catch (error) {
    deleteImportedFontFiles(imported);
    throw error;
  }
}

export function deleteImportedFontFiles(faces: readonly ImportedFontFace[]) {
  for (const face of faces) {
    const file = fontFile(face);
    if (file.exists) file.delete();
  }
}

export async function loadImportedFontFiles(faces: readonly ImportedFontFace[]) {
  const variants = new Map<string, NonNullable<ReturnType<typeof importedFontVariant>>>();
  for (const family of importedFontFamilies(faces)) {
    for (const weight of [400, 500, 700]) {
      const variant = importedFontVariant(faces, family, weight);
      if (variant) variants.set(variant.alias, variant);
    }
  }
  const loaded = new Set<string>();
  const unavailable: string[] = [];
  await Promise.all(
    [...variants.values()].map(async (variant) => {
      try {
        if (!Font.isLoaded(variant.alias))
          await Font.loadAsync([
            {
              fontFamily: variant.alias,
              fontDefinitions: variant.faces.map((face) => ({
                path: fontFile(face).uri,
                weight: face.weight,
                style: face.italic ? ("italic" as const) : ("normal" as const),
              })),
            },
          ]);
        loaded.add(variant.alias);
      } catch {
        const family = variant.faces[0]?.family;
        if (family && !unavailable.includes(family)) unavailable.push(family);
      }
    }),
  );
  return { loaded, unavailable };
}
