import { getStateFromPath } from "@react-navigation/native";

export const THREAD_LINKING_PREFIX = "threads/:environmentId/:threadId";

const THREAD_FILES_PATH = `${THREAD_LINKING_PREFIX}/files`;
const DRAFT_FILES_PATH = "new/draft/files";

function fileScreenPath(prefix: string) {
  return {
    path: `${prefix}/:path([\\s\\S]+)`,
    // Older URLs used "undefined" in the pathname and put file segments in the query.
    alias: [`${prefix}/undefined`],
    stringify: { path: (path: unknown) => (Array.isArray(path) ? path.join("/") : String(path)) },
  };
}

export const fileScreenLinking = {
  ThreadFiles: THREAD_FILES_PATH,
  ThreadFile: fileScreenPath(THREAD_FILES_PATH),
  NewTaskFiles: DRAFT_FILES_PATH,
  NewTaskFile: fileScreenPath(DRAFT_FILES_PATH),
};

export function getStackStateFromPath(
  path: string,
  options?: Parameters<typeof getStateFromPath>[1],
) {
  const state = getStateFromPath(path, options);
  if (!state) return state;
  const route = state.routes.at(-1);
  if (route?.name === "ThreadFile" || route?.name === "NewTaskFile") {
    const params = route.params ?? {};
    // The alias also matches a file literally named "undefined".
    if (!("path" in params) || params.path == null) {
      return {
        ...state,
        routes: [
          ...state.routes.slice(0, -1),
          { ...route, params: { ...params, path: "undefined" } },
        ],
      };
    }
  }
  return state;
}
