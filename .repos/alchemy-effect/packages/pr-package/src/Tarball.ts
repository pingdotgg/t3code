export type TarballRef = readonly [packageName: string, hash: string];

export const tarballRef = (packageName: string, hash: string): TarballRef => [
  packageName,
  hash,
];

export const tarballId = (ref: TarballRef) => JSON.stringify(ref);

export const tarballKey = ([packageName, hash]: TarballRef) =>
  `${encodeURIComponent(packageName)}/${hash}.tgz`;
