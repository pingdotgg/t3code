import { createCordisRuntime } from "./cordisRuntime.ts";
import { defineRuntimeContract } from "./runtimeContract.ts";

defineRuntimeContract("cordis runtime", createCordisRuntime);
