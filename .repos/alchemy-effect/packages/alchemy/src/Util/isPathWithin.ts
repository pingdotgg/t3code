import path from "pathe";

/**
 * Test lexical containment, including equality, using an explicit absolute base
 * for relative paths. Does not follow symlinks or consult the working directory.
 */
export const isPathWithin = (
  directory: string,
  candidate: string,
  base: string,
): boolean => {
  const relative = path.relative(
    path.resolve(base, directory),
    path.resolve(base, candidate),
  );
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith("../"))
  );
};
