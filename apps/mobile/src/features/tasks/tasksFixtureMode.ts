// Design and screenshot runs only: `EXPO_PUBLIC_CONN_TASKS_FIXTURE=1` swaps Orbit's tasks, the
// fixture task's pull request and the board's numbers for fixture data. Development builds only,
// so a release build can never show it, whatever its environment says.
const DEVELOPMENT = typeof __DEV__ !== "undefined" && __DEV__;

export const TASKS_FIXTURES = DEVELOPMENT && process.env.EXPO_PUBLIC_CONN_TASKS_FIXTURE === "1";

/** `EXPO_PUBLIC_CONN_TASKS_FIXTURE_INSIGHTS=unhandled`: the numbers fail as the live Gateway does. */
export const TASKS_FIXTURE_INSIGHTS =
  process.env.EXPO_PUBLIC_CONN_TASKS_FIXTURE_INSIGHTS === "unhandled" ? "unhandled" : "fixture";
