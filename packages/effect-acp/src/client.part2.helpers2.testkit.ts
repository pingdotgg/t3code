// @effect-diagnostics preferSchemaOverJson:off effectFnOpportunity:off
import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as AcpClient from "./client.ts";
import * as AcpSchema from "./_generated/schema.gen.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import * as AcpError from "./errors.ts";
import type * as AcpCompat from "./compat.ts";
import type * as AcpProtocol from "./protocol.ts";
import {
  encodeJsonl,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
} from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
import antigravityInitialize from "../test/fixtures/antigravity-initialize.json" with { type: "json" };
import { DieResponse, ErrorResponse, ExtRequest, ExtResponse, InitializeRequest, InitializeRequestV1, InitializeResponse, InitializeResponseV1, NewSessionRequestV1, PermissionRequest, PermissionResponse, PromptRequest, PromptRequestV1, PromptResponse, PromptResponseV1, SessionUpdateNotification, XAiPromptCompleteNotification, XAiQueueChangedNotification, XAiSessionsChangedNotification, concatBytes, decodePromptRequestLine, decodeWireError, decodeWireResponse, elicitationForm, mockPeerArgs, mockPeerPath, mockStartupNotice, stripMockStartupNotice } from "./client.helpers2.testkit.ts";


