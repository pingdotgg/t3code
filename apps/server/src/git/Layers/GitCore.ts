import { Layer } from "effect";

import { GitCore } from "../Services/GitCore.ts";
import { makeGitCore } from "./GitCore.shared.ts";

export const GitCoreLive = Layer.effect(GitCore, makeGitCore());
