declare const __T3CODE_BUILD_STANDALONE__: boolean | undefined;

/** Set by `T3CODE_STANDALONE=1` builds through scripts/lib/standalone-build.ts. */
export const IS_STANDALONE_BUILD =
  typeof __T3CODE_BUILD_STANDALONE__ === "boolean" && __T3CODE_BUILD_STANDALONE__;

/** Who publishes standalone builds, for package metadata and links that would name T3. */
export const STANDALONE_VENDOR = {
  name: "EasyDev Soluções Digitais",
  homepage: "https://easydevsolucoes.com.br",
  email: "contato@easydevsolucoes.com.br",
  committer: { name: "EasyDev Code", email: "noreply@easydevsolucoes.com.br" },
} as const;
