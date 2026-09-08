import { createRequire } from "node:module";

// `make-dir` is installed into the artifact by `build.install`, not bundled,
// so it is loaded through a runtime require against the artifact's
// node_modules — exactly what a deployed function does.
const nodeRequire = createRequire(import.meta.url);

const handler = async () => {
  const makeDir = nodeRequire("make-dir") as (path: string) => Promise<string>;
  await makeDir("/tmp/alchemy-lockfile-pinning");
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      makeDir: (nodeRequire("make-dir/package.json") as { version: string })
        .version,
      semver: (nodeRequire("semver/package.json") as { version: string })
        .version,
    }),
  };
};

export { handler };
export default handler;
