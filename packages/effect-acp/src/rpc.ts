import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { AGENT_METHODS, CLIENT_METHODS } from "./_generated/meta.gen.ts";

export const InitializeRpc = Rpc.make(AGENT_METHODS.initialize, {
  payload: AcpSchema.InitializeRequest,
  success: AcpSchema.InitializeResponse,
  error: AcpSchema.Error,
});

export const AuthenticateRpc = Rpc.make(AGENT_METHODS.authenticate, {
  payload: AcpSchema.AuthenticateRequest,
  success: AcpSchema.AuthenticateResponse,
  error: AcpSchema.Error,
});

export const LogoutRpc = Rpc.make(AGENT_METHODS.logout, {
  payload: AcpSchema.LogoutRequest,
  success: AcpSchema.LogoutResponse,
  error: AcpSchema.Error,
});

export const NewSessionRpc = Rpc.make(AGENT_METHODS.session_new, {
  payload: AcpSchema.NewSessionRequest,
  success: AcpSchema.NewSessionResponse,
  error: AcpSchema.Error,
});

export const LoadSessionRpc = Rpc.make(AGENT_METHODS.session_load, {
  payload: AcpSchema.LoadSessionRequest,
  success: AcpSchema.LoadSessionResponse,
  error: AcpSchema.Error,
});

export const ListSessionsRpc = Rpc.make(AGENT_METHODS.session_list, {
  payload: AcpSchema.ListSessionsRequest,
  success: AcpSchema.ListSessionsResponse,
  error: AcpSchema.Error,
});

export const ForkSessionRpc = Rpc.make(AGENT_METHODS.session_fork, {
  payload: AcpSchema.ForkSessionRequest,
  success: AcpSchema.ForkSessionResponse,
  error: AcpSchema.Error,
});

export const ResumeSessionRpc = Rpc.make(AGENT_METHODS.session_resume, {
  payload: AcpSchema.ResumeSessionRequest,
  success: AcpSchema.ResumeSessionResponse,
  error: AcpSchema.Error,
});

export const CloseSessionRpc = Rpc.make(AGENT_METHODS.session_close, {
  payload: AcpSchema.CloseSessionRequest,
  success: AcpSchema.CloseSessionResponse,
  error: AcpSchema.Error,
});

export const PromptRpc = Rpc.make(AGENT_METHODS.session_prompt, {
  payload: AcpSchema.PromptRequest,
  success: AcpSchema.PromptResponse,
  error: AcpSchema.Error,
});

export const SetSessionModelRpc = Rpc.make(AGENT_METHODS.session_set_model, {
  payload: AcpSchema.SetSessionModelRequest,
  success: AcpSchema.SetSessionModelResponse,
  error: AcpSchema.Error,
});

export const SetSessionConfigOptionRpc = Rpc.make(AGENT_METHODS.session_set_config_option, {
  payload: AcpSchema.SetSessionConfigOptionRequest,
  success: AcpSchema.SetSessionConfigOptionResponse,
  error: AcpSchema.Error,
});

export const ReadTextFileRpc = Rpc.make(CLIENT_METHODS.fs_read_text_file, {
  payload: AcpSchema.ReadTextFileRequest,
  success: AcpSchema.ReadTextFileResponse,
  error: AcpSchema.Error,
});

export const WriteTextFileRpc = Rpc.make(CLIENT_METHODS.fs_write_text_file, {
  payload: AcpSchema.WriteTextFileRequest,
  success: AcpSchema.WriteTextFileResponse,
  error: AcpSchema.Error,
});

export const RequestPermissionRpc = Rpc.make(CLIENT_METHODS.session_request_permission, {
  payload: AcpSchema.RequestPermissionRequest,
  success: AcpSchema.RequestPermissionResponse,
  error: AcpSchema.Error,
});

export const ElicitationRpc = Rpc.make(CLIENT_METHODS.session_elicitation, {
  payload: AcpSchema.ElicitationRequest,
  success: AcpSchema.ElicitationResponse,
  error: AcpSchema.Error,
});

export const CreateTerminalRpc = Rpc.make(CLIENT_METHODS.terminal_create, {
  payload: AcpSchema.CreateTerminalRequest,
  success: AcpSchema.CreateTerminalResponse,
  error: AcpSchema.Error,
});

export const TerminalOutputRpc = Rpc.make(CLIENT_METHODS.terminal_output, {
  payload: AcpSchema.TerminalOutputRequest,
  success: AcpSchema.TerminalOutputResponse,
  error: AcpSchema.Error,
});

export const ReleaseTerminalRpc = Rpc.make(CLIENT_METHODS.terminal_release, {
  payload: AcpSchema.ReleaseTerminalRequest,
  success: AcpSchema.ReleaseTerminalResponse,
  error: AcpSchema.Error,
});

export const WaitForTerminalExitRpc = Rpc.make(CLIENT_METHODS.terminal_wait_for_exit, {
  payload: AcpSchema.WaitForTerminalExitRequest,
  success: AcpSchema.WaitForTerminalExitResponse,
  error: AcpSchema.Error,
});

export const KillTerminalRpc = Rpc.make(CLIENT_METHODS.terminal_kill, {
  payload: AcpSchema.KillTerminalRequest,
  success: AcpSchema.KillTerminalResponse,
  error: AcpSchema.Error,
});

export const AgentRpcs = RpcGroup.make(
  InitializeRpc,
  AuthenticateRpc,
  LogoutRpc,
  NewSessionRpc,
  LoadSessionRpc,
  ListSessionsRpc,
  ForkSessionRpc,
  ResumeSessionRpc,
  CloseSessionRpc,
  PromptRpc,
  SetSessionModelRpc,
  SetSessionConfigOptionRpc,
);

export const ClientRpcs = RpcGroup.make(
  ReadTextFileRpc,
  WriteTextFileRpc,
  RequestPermissionRpc,
  ElicitationRpc,
  CreateTerminalRpc,
  TerminalOutputRpc,
  ReleaseTerminalRpc,
  WaitForTerminalExitRpc,
  KillTerminalRpc,
);
