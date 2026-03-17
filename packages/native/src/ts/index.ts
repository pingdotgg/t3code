import * as binding from "./binding.js";

function doesNativeModuleWork(): boolean {
  try {
    return binding.ping() === "pong";
  } catch (error) {
    console.error(error);
    return false;
  }
}

export { doesNativeModuleWork };
