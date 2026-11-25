import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { planDirectPushRegistration } from "./directPushPlan";

const HOME = EnvironmentId.make("home");
const WORK = EnvironmentId.make("work");
const OLD = EnvironmentId.make("old-server");

it.each([
  {
    name: "registers every connected environment that advertises direct push",
    token: "token-a",
    connected: [HOME, WORK, OLD],
    registered: new Map(),
    register: [HOME, WORK],
    forget: [],
  },
  {
    name: "skips environments already holding the current token",
    token: "token-a",
    connected: [HOME, WORK],
    registered: new Map([[HOME, "token-a"]]),
    register: [WORK],
    forget: [],
  },
  {
    name: "re-registers when the token rotates",
    token: "token-b",
    connected: [HOME],
    registered: new Map([[HOME, "token-a"]]),
    register: [HOME],
    forget: [],
  },
  {
    name: "forgets a disconnected environment so a reconnect registers again",
    token: "token-a",
    connected: [HOME],
    registered: new Map([
      [HOME, "token-a"],
      [WORK, "token-a"],
    ]),
    register: [],
    forget: [WORK],
  },
  {
    name: "registers nothing without a token",
    token: null,
    connected: [HOME],
    registered: new Map(),
    register: [],
    forget: [],
  },
])("$name", ({ token, connected, registered, register, forget }) => {
  expect(
    planDirectPushRegistration({
      token,
      connected,
      supportsDirectPush: (id) => id !== OLD,
      registered,
    }),
  ).toEqual({ register, forget });
});
