import * as vscode from "vscode";

import { BackendManager } from "./backendManager.ts";
import {
  createClientSettingsPersistence,
  registerClientSettingsHostBridge,
  resolveClientSettingsPath,
} from "./clientSettingsPersistence.ts";
import { renderT3Webview } from "./webview.ts";

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("T3 Code");
  const backendManager = new BackendManager(context, outputChannel);

  context.subscriptions.push(outputChannel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "t3code.sidebarView",
      new T3SidebarProvider(context, backendManager, outputChannel),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "t3code.conversationEditor",
      new T3ConversationEditorProvider(context, backendManager, outputChannel),
      { supportsMultipleEditorsPerDocument: true },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("t3code.open", async () => {
      await vscode.commands.executeCommand("t3code.sidebarView.focus");
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("t3code.newThread", async () => {
      const uri = vscode.Uri.parse(`t3-code://route/local/new?ts=${Date.now()}`);
      await vscode.commands.executeCommand("vscode.openWith", uri, "t3code.conversationEditor");
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("t3code.restartBackend", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Restarting T3 Code backend",
        },
        async () => {
          await backendManager.restart();
        },
      );
    }),
  );
  context.subscriptions.push({
    dispose: () => {
      void backendManager.stop();
    },
  });
}

export function deactivate() {}

class T3SidebarProvider implements vscode.WebviewViewProvider {
  readonly #context: vscode.ExtensionContext;
  readonly #backendManager: BackendManager;
  readonly #outputChannel: vscode.OutputChannel;

  constructor(
    context: vscode.ExtensionContext,
    backendManager: BackendManager,
    outputChannel: vscode.OutputChannel,
  ) {
    this.#context = context;
    this.#backendManager = backendManager;
    this.#outputChannel = outputChannel;
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    configureWebview(webviewView.webview, this.#context.extensionUri);
    const connection = await this.#backendManager.ensureStarted();
    const bridgeDisposable = registerClientSettingsHostBridge({
      webview: webviewView.webview,
      persistence: createClientSettingsPersistence(resolveClientSettingsPath(connection.t3Home)),
      outputChannel: this.#outputChannel,
    });
    webviewView.onDidDispose(() => bridgeDisposable.dispose());
    webviewView.webview.html = await renderT3Webview({
      webview: webviewView.webview,
      extensionUri: this.#context.extensionUri,
      connection,
      initialRoute: "/_chat/",
    });
  }
}

class T3ConversationDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;

  constructor(uri: vscode.Uri) {
    this.uri = uri;
  }

  dispose() {}
}

class T3ConversationEditorProvider implements vscode.CustomReadonlyEditorProvider<T3ConversationDocument> {
  readonly #context: vscode.ExtensionContext;
  readonly #backendManager: BackendManager;
  readonly #outputChannel: vscode.OutputChannel;

  constructor(
    context: vscode.ExtensionContext,
    backendManager: BackendManager,
    outputChannel: vscode.OutputChannel,
  ) {
    this.#context = context;
    this.#backendManager = backendManager;
    this.#outputChannel = outputChannel;
  }

  openCustomDocument(uri: vscode.Uri): T3ConversationDocument {
    return new T3ConversationDocument(uri);
  }

  async resolveCustomEditor(
    document: T3ConversationDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    configureWebview(webviewPanel.webview, this.#context.extensionUri);
    const connection = await this.#backendManager.ensureStarted();
    const bridgeDisposable = registerClientSettingsHostBridge({
      webview: webviewPanel.webview,
      persistence: createClientSettingsPersistence(resolveClientSettingsPath(connection.t3Home)),
      outputChannel: this.#outputChannel,
    });
    webviewPanel.onDidDispose(() => bridgeDisposable.dispose());
    webviewPanel.webview.html = await renderT3Webview({
      webview: webviewPanel.webview,
      extensionUri: this.#context.extensionUri,
      connection,
      initialRoute: routeFromUri(document.uri),
    });
  }
}

function configureWebview(webview: vscode.Webview, extensionUri: vscode.Uri) {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist", "webview")],
  };
}

function routeFromUri(uri: vscode.Uri): string {
  const routeParts = uri.path.split("/").filter(Boolean);
  const threadId = routeParts.at(-1);
  if (!threadId || threadId === "new") {
    return "/_chat/";
  }
  return "/_chat/";
}
