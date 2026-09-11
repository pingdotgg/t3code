import { WS_METHODS, type ThreadForkInput } from "@t3tools/contracts";

import { request } from "../rpc/client.ts";

export const forkThread = (input: ThreadForkInput) => request(WS_METHODS.threadsFork, input);
