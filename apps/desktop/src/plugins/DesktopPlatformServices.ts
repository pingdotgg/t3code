import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { builtinServiceLayer } from "@t3tools/shared/pluginKernel";
import * as Net from "@t3tools/shared/Net";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stdio from "effect/Stdio";
import * as Terminal from "effect/Terminal";
import { ChildProcessSpawner } from "effect/process";
import { HttpClient } from "effect/http";

/** Actual platform factories remain scoped to their original Node services. */
export const layer = Layer.mergeAll(
  builtinServiceLayer("t3.desktop.filesystem", FileSystem.FileSystem, FileSystem.FileSystem),
  builtinServiceLayer("t3.desktop.path", Path.Path, Path.Path),
  builtinServiceLayer("t3.desktop.stdio", Stdio.Stdio, Stdio.Stdio),
  builtinServiceLayer("t3.desktop.terminal", Terminal.Terminal, Terminal.Terminal),
  builtinServiceLayer(
    "t3.desktop.process",
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.ChildProcessSpawner,
  ),
  builtinServiceLayer("t3.desktop.http", HttpClient.HttpClient, HttpClient.HttpClient),
  builtinServiceLayer("t3.desktop.network", Net.NetService, Net.NetService),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, Net.layer)));
