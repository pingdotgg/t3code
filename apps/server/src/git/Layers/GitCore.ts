import { Layer } from "effect";
import { makeGitCore } from "./GitCore.shared";
import { GitCore } from "../Services/GitCore.ts";

export const GitCoreLive = Layer.effect(GitCore, makeGitCore());
