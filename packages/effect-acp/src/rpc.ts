import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import * as AcpSchema from "./_generated/schema.gen.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import { AGENT_METHODS, CLIENT_METHODS } from "./_generated/meta.gen.ts";

export const V1_AGENT_METHODS = {
  authenticate: "authenticate",
  logout: "logout",
  session_load: "session/load",
} as const;

export const V1_CLIENT_METHODS = {
  fs_read_text_file: "fs/read_text_file",
  fs_write_text_file: "fs/write_text_file",
  terminal_create: "terminal/create",
  terminal_output: "terminal/output",
  terminal_release: "terminal/release",
  terminal_wait_for_exit: "terminal/wait_for_exit",
  terminal_kill: "terminal/kill",
} as const;

export const InitializeRpc = Rpc.make(AGENT_METHODS.initialize, {
  payload: AcpSchema.InitializeRequest,
  success: AcpSchema.InitializeResponse,
  error: AcpSchema.Error,
});

export const LoginRpc = Rpc.make(AGENT_METHODS.auth_login, {
  payload: AcpSchema.LoginAuthRequest,
  success: AcpSchema.LoginAuthResponse,
  error: AcpSchema.Error,
});

export const LogoutRpc = Rpc.make(AGENT_METHODS.auth_logout, {
  payload: AcpSchema.LogoutAuthRequest,
  success: AcpSchema.LogoutAuthResponse,
  error: AcpSchema.Error,
});

export const NewSessionRpc = Rpc.make(AGENT_METHODS.session_new, {
  payload: AcpSchema.NewSessionRequest,
  success: AcpSchema.NewSessionResponse,
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

export const DeleteSessionRpc = Rpc.make(AGENT_METHODS.session_delete, {
  payload: AcpSchema.DeleteSessionRequest,
  success: AcpSchema.DeleteSessionResponse,
  error: AcpSchema.Error,
});

export const ListProvidersRpc = Rpc.make(AGENT_METHODS.providers_list, {
  payload: AcpSchema.ListProvidersRequest,
  success: AcpSchema.ListProvidersResponse,
  error: AcpSchema.Error,
});

export const SetProviderRpc = Rpc.make(AGENT_METHODS.providers_set, {
  payload: AcpSchema.SetProviderRequest,
  success: AcpSchema.SetProviderResponse,
  error: AcpSchema.Error,
});

export const DisableProviderRpc = Rpc.make(AGENT_METHODS.providers_disable, {
  payload: AcpSchema.DisableProviderRequest,
  success: AcpSchema.DisableProviderResponse,
  error: AcpSchema.Error,
});

export const PromptRpc = Rpc.make(AGENT_METHODS.session_prompt, {
  payload: AcpSchema.PromptRequest,
  success: AcpSchema.PromptResponse,
  error: AcpSchema.Error,
});

export const SetSessionConfigOptionRpc = Rpc.make(AGENT_METHODS.session_set_config_option, {
  payload: AcpSchema.SetSessionConfigOptionRequest,
  success: AcpSchema.SetSessionConfigOptionResponse,
  error: AcpSchema.Error,
});

export const RequestPermissionRpc = Rpc.make(CLIENT_METHODS.session_request_permission, {
  payload: AcpSchema.RequestPermissionRequest,
  success: AcpSchema.RequestPermissionResponse,
  error: AcpSchema.Error,
});

export const ElicitationRpc = Rpc.make(CLIENT_METHODS.elicitation_create, {
  payload: AcpSchema.CreateElicitationRequest,
  success: AcpSchema.CreateElicitationResponse,
  error: AcpSchema.Error,
});

export const AgentRpcs = RpcGroup.make(
  InitializeRpc,
  LoginRpc,
  LogoutRpc,
  NewSessionRpc,
  ListSessionsRpc,
  ForkSessionRpc,
  ResumeSessionRpc,
  CloseSessionRpc,
  DeleteSessionRpc,
  ListProvidersRpc,
  SetProviderRpc,
  DisableProviderRpc,
  PromptRpc,
  SetSessionConfigOptionRpc,
);

// Registry agents transition independently. The compatibility groups accept
// both protocol generations on the wire while the public client normalizes
// them into one provider-neutral surface after initialize negotiates v1 or v2.
const CompatInitializeRpc = Rpc.make(AGENT_METHODS.initialize, {
  // The negotiation request intentionally carries both v1 and v2 capability
  // field names. A union encoder would select one branch and discard the
  // other generation's fields before they reach the agent.
  payload: Schema.Unknown,
  success: Schema.Union([AcpSchema.InitializeResponse, AcpSchemaV1.InitializeResponse]),
  error: AcpSchema.Error,
});

const CompatAuthenticateV1Rpc = Rpc.make(V1_AGENT_METHODS.authenticate, {
  payload: AcpSchemaV1.AuthenticateRequest,
  success: AcpSchemaV1.AuthenticateResponse,
  error: AcpSchemaV1.Error,
});

const CompatLogoutV1Rpc = Rpc.make(V1_AGENT_METHODS.logout, {
  payload: AcpSchemaV1.LogoutRequest,
  success: AcpSchemaV1.LogoutResponse,
  error: AcpSchemaV1.Error,
});

const CompatNewSessionRpc = Rpc.make(AGENT_METHODS.session_new, {
  payload: Schema.Union([AcpSchema.NewSessionRequest, AcpSchemaV1.NewSessionRequest]),
  success: Schema.Union([AcpSchemaV1.NewSessionResponse, AcpSchema.NewSessionResponse]),
  error: AcpSchema.Error,
});

const CompatLoadSessionV1Rpc = Rpc.make(V1_AGENT_METHODS.session_load, {
  payload: AcpSchemaV1.LoadSessionRequest,
  success: AcpSchemaV1.LoadSessionResponse,
  error: AcpSchemaV1.Error,
});

const CompatListSessionsRpc = Rpc.make(AGENT_METHODS.session_list, {
  payload: Schema.Union([AcpSchema.ListSessionsRequest, AcpSchemaV1.ListSessionsRequest]),
  success: Schema.Union([AcpSchemaV1.ListSessionsResponse, AcpSchema.ListSessionsResponse]),
  error: AcpSchema.Error,
});

const CompatForkSessionRpc = Rpc.make(AGENT_METHODS.session_fork, {
  payload: Schema.Union([AcpSchema.ForkSessionRequest, AcpSchemaV1.ForkSessionRequest]),
  success: Schema.Union([AcpSchemaV1.ForkSessionResponse, AcpSchema.ForkSessionResponse]),
  error: AcpSchema.Error,
});

const CompatResumeSessionRpc = Rpc.make(AGENT_METHODS.session_resume, {
  payload: Schema.Union([AcpSchema.ResumeSessionRequest, AcpSchemaV1.ResumeSessionRequest]),
  success: Schema.Union([AcpSchemaV1.ResumeSessionResponse, AcpSchema.ResumeSessionResponse]),
  error: AcpSchema.Error,
});

const CompatCloseSessionRpc = Rpc.make(AGENT_METHODS.session_close, {
  payload: Schema.Union([AcpSchema.CloseSessionRequest, AcpSchemaV1.CloseSessionRequest]),
  success: Schema.Union([AcpSchema.CloseSessionResponse, AcpSchemaV1.CloseSessionResponse]),
  error: AcpSchema.Error,
});

const CompatDeleteSessionRpc = Rpc.make(AGENT_METHODS.session_delete, {
  payload: AcpSchema.DeleteSessionRequest,
  success: AcpSchema.DeleteSessionResponse,
  error: AcpSchema.Error,
});

const CompatListProvidersRpc = Rpc.make(AGENT_METHODS.providers_list, {
  payload: AcpSchema.ListProvidersRequest,
  success: AcpSchema.ListProvidersResponse,
  error: AcpSchema.Error,
});

const CompatSetProviderRpc = Rpc.make(AGENT_METHODS.providers_set, {
  payload: AcpSchema.SetProviderRequest,
  success: AcpSchema.SetProviderResponse,
  error: AcpSchema.Error,
});

const CompatDisableProviderRpc = Rpc.make(AGENT_METHODS.providers_disable, {
  payload: AcpSchema.DisableProviderRequest,
  success: AcpSchema.DisableProviderResponse,
  error: AcpSchema.Error,
});

const CompatPromptRpc = Rpc.make(AGENT_METHODS.session_prompt, {
  payload: Schema.Union([AcpSchema.PromptRequest, AcpSchemaV1.PromptRequest]),
  success: Schema.Union([AcpSchemaV1.PromptResponse, AcpSchema.PromptResponse]),
  error: AcpSchema.Error,
});

const CompatSetSessionConfigOptionRpc = Rpc.make(AGENT_METHODS.session_set_config_option, {
  payload: Schema.Union([
    AcpSchema.SetSessionConfigOptionRequest,
    AcpSchemaV1.SetSessionConfigOptionRequest,
  ]),
  success: Schema.Union([
    AcpSchemaV1.SetSessionConfigOptionResponse,
    AcpSchema.SetSessionConfigOptionResponse,
  ]),
  error: AcpSchema.Error,
});

export const CompatAgentRpcs = RpcGroup.make(
  CompatInitializeRpc,
  LoginRpc,
  CompatAuthenticateV1Rpc,
  LogoutRpc,
  CompatLogoutV1Rpc,
  CompatNewSessionRpc,
  CompatLoadSessionV1Rpc,
  CompatListSessionsRpc,
  CompatForkSessionRpc,
  CompatResumeSessionRpc,
  CompatCloseSessionRpc,
  CompatDeleteSessionRpc,
  CompatListProvidersRpc,
  CompatSetProviderRpc,
  CompatDisableProviderRpc,
  CompatPromptRpc,
  CompatSetSessionConfigOptionRpc,
);

const CompatRequestPermissionRpc = Rpc.make(CLIENT_METHODS.session_request_permission, {
  payload: Schema.Union([AcpSchema.RequestPermissionRequest, AcpSchemaV1.RequestPermissionRequest]),
  success: Schema.Union([
    AcpSchema.RequestPermissionResponse,
    AcpSchemaV1.RequestPermissionResponse,
  ]),
  error: AcpSchema.Error,
});

const CompatElicitationRpc = Rpc.make(CLIENT_METHODS.elicitation_create, {
  payload: Schema.Union([AcpSchema.CreateElicitationRequest, AcpSchemaV1.CreateElicitationRequest]),
  success: Schema.Union([
    AcpSchema.CreateElicitationResponse,
    AcpSchemaV1.CreateElicitationResponse,
  ]),
  error: AcpSchema.Error,
});

const ConnectMcpRpc = Rpc.make(CLIENT_METHODS.mcp_connect, {
  payload: AcpSchema.ConnectMcpRequest,
  success: AcpSchema.ConnectMcpResponse,
  error: AcpSchema.Error,
});

const MessageMcpRpc = Rpc.make(CLIENT_METHODS.mcp_message, {
  payload: AcpSchema.MessageMcpRequest,
  success: AcpSchema.MessageMcpResponse,
  error: AcpSchema.Error,
});

const DisconnectMcpRpc = Rpc.make(CLIENT_METHODS.mcp_disconnect, {
  payload: AcpSchema.DisconnectMcpRequest,
  success: AcpSchema.DisconnectMcpResponse,
  error: AcpSchema.Error,
});

export const ClientRpcs = RpcGroup.make(
  RequestPermissionRpc,
  ElicitationRpc,
  ConnectMcpRpc,
  MessageMcpRpc,
  DisconnectMcpRpc,
);

const ReadTextFileV1Rpc = Rpc.make(V1_CLIENT_METHODS.fs_read_text_file, {
  payload: AcpSchemaV1.ReadTextFileRequest,
  success: AcpSchemaV1.ReadTextFileResponse,
  error: AcpSchemaV1.Error,
});

const WriteTextFileV1Rpc = Rpc.make(V1_CLIENT_METHODS.fs_write_text_file, {
  payload: AcpSchemaV1.WriteTextFileRequest,
  success: AcpSchemaV1.WriteTextFileResponse,
  error: AcpSchemaV1.Error,
});

const CreateTerminalV1Rpc = Rpc.make(V1_CLIENT_METHODS.terminal_create, {
  payload: AcpSchemaV1.CreateTerminalRequest,
  success: AcpSchemaV1.CreateTerminalResponse,
  error: AcpSchemaV1.Error,
});

const TerminalOutputV1Rpc = Rpc.make(V1_CLIENT_METHODS.terminal_output, {
  payload: AcpSchemaV1.TerminalOutputRequest,
  success: AcpSchemaV1.TerminalOutputResponse,
  error: AcpSchemaV1.Error,
});

const ReleaseTerminalV1Rpc = Rpc.make(V1_CLIENT_METHODS.terminal_release, {
  payload: AcpSchemaV1.ReleaseTerminalRequest,
  success: AcpSchemaV1.ReleaseTerminalResponse,
  error: AcpSchemaV1.Error,
});

const WaitForTerminalExitV1Rpc = Rpc.make(V1_CLIENT_METHODS.terminal_wait_for_exit, {
  payload: AcpSchemaV1.WaitForTerminalExitRequest,
  success: AcpSchemaV1.WaitForTerminalExitResponse,
  error: AcpSchemaV1.Error,
});

const KillTerminalV1Rpc = Rpc.make(V1_CLIENT_METHODS.terminal_kill, {
  payload: AcpSchemaV1.KillTerminalRequest,
  success: AcpSchemaV1.KillTerminalResponse,
  error: AcpSchemaV1.Error,
});

export const CompatClientRpcs = RpcGroup.make(
  CompatRequestPermissionRpc,
  CompatElicitationRpc,
  ConnectMcpRpc,
  MessageMcpRpc,
  DisconnectMcpRpc,
  ReadTextFileV1Rpc,
  WriteTextFileV1Rpc,
  CreateTerminalV1Rpc,
  TerminalOutputV1Rpc,
  ReleaseTerminalV1Rpc,
  WaitForTerminalExitV1Rpc,
  KillTerminalV1Rpc,
);
