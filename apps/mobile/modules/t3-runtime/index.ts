import { requireNativeModule } from "expo-modules-core";

export interface LocalRuntimeState {
  phase: "stopped" | "stopping" | "installing" | "starting" | "ready" | "error";
  message: string;
  connection: { url: string; token: string; project: string } | null;
  login: { running: boolean; text: string };
}
export const localRuntime = requireNativeModule<{
  start(): Promise<LocalRuntimeState>;
  stop(): Promise<void>;
  signIn(): Promise<void>;
  addListener(event: "onState", listener: (state: LocalRuntimeState) => void): { remove(): void };
}>("T3Runtime");
