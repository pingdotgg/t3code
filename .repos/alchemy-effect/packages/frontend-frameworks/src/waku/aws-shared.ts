/**
 * Constants shared between the AWS deploy target (`./aws.ts`, loaded in the
 * Node build/deploy process) and the AWS adapter (`./aws-adapter.ts`, bundled
 * into the Lambda server bundle by waku's vite pipeline). Kept in a
 * dependency-free module: the target must be importable WITHOUT dragging in
 * `waku/adapter-builders` (which only loads inside waku's vite context), and
 * the adapter must stay free of Effect imports.
 */

/**
 * The global the generated serve entry reads: a
 * `(fetch, { streaming }) => lambdaHandler` wrapper published when the
 * server-entry module evaluates (importing `dist/server/index.js` runs the
 * adapter setup). Namespaced away from upstream waku's
 * `__WAKU_AWS_LAMBDA_HANDLE__` so both adapters could coexist.
 */
export const AWS_LAMBDA_HANDLE_GLOBAL = "__ALCHEMY_WAKU_AWS_LAMBDA_HANDLE__";
