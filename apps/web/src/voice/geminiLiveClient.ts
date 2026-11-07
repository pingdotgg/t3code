import { GeminiAudioPlayer, GeminiMicCapture } from "./geminiLiveAudio";
import type {
  GeminiLiveSettings,
  GeminiLiveStatus,
  GeminiLiveToolHandlers,
  VoiceActivityItem,
} from "./geminiLiveTypes";

const GEMINI_LIVE_WS_BASE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";

const SYSTEM_INSTRUCTION_TEXT = [
  "You are the live voice interface for T3 Code, an open-source agentic coding environment.",
  "You speak directly with the developer in real time and coordinate their coding agents.",
  "Keep your spoken responses concise, natural, and conversational. Never read raw code blocks or long file paths character-by-character.",
  "Use your tools whenever the user asks to:",
  "- Send a task, prompt, bug report, or answer to the coding agent (`send_message_to_agent`).",
  "- Check what the coding agent is currently doing or read the latest thread messages (`get_thread_status`).",
  "- Stop or cancel the coding agent's current run (`interrupt_agent`).",
  "- Open a fresh coding thread in the current project (`start_new_thread`).",
  "When you receive a message starting with [T3_CODE_AGENT_UPDATE], the coding agent in T3 Code has just finished a turn or is waiting for user input. Immediately speak a brief, helpful summary of what the coding agent accomplished or what question it is asking.",
].join("\n");

const GEMINI_LIVE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "send_message_to_agent",
        description:
          "Send a coding prompt, instruction, or follow-up message to the active T3 Code thread so the coding agent executes it.",
        parameters: {
          type: "OBJECT",
          properties: {
            prompt: {
              type: "STRING",
              description:
                "The clear, complete instruction or message to send to the coding agent in T3 Code.",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "get_thread_status",
        description:
          "Read the active T3 Code thread title, project name, whether the coding agent is currently working or idle, any pending approvals/questions, and the recent conversation messages.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "interrupt_agent",
        description: "Stop or interrupt the currently running coding agent turn in T3 Code.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "start_new_thread",
        description: "Start a brand new coding thread in the active T3 Code project.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
    ],
  },
];

interface GeminiServerMessage {
  setupComplete?: Record<string, unknown>;
  serverContent?: {
    interrupted?: boolean;
    turnComplete?: boolean;
    modelTurn?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType?: string;
          data?: string;
        };
      }>;
    };
  };
  toolCall?: {
    functionCalls?: Array<{
      id: string;
      name: string;
      args?: Record<string, unknown>;
    }>;
  };
}

export interface GeminiLiveSessionCallbacks {
  readonly onStatusChange: (status: GeminiLiveStatus, errorText?: string | null) => void;
  readonly onInputLevelChange: (level: number) => void;
  readonly onOutputLevelChange: (level: number) => void;
  readonly onActivity: (item: VoiceActivityItem) => void;
  readonly getToolHandlers: () => GeminiLiveToolHandlers;
}

function makeActivityId(): string {
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private mic: GeminiMicCapture | null = null;
  private player: GeminiAudioPlayer | null = null;
  private status: GeminiLiveStatus = "idle";
  private isSpeakingAudio = false;
  private setupCompleted = false;
  private callbacks: GeminiLiveSessionCallbacks;

  constructor(callbacks: GeminiLiveSessionCallbacks) {
    this.callbacks = callbacks;
  }

  private setStatus(next: GeminiLiveStatus, errorText: string | null = null): void {
    this.status = next;
    this.callbacks.onStatusChange(next, errorText);
  }

  private emitActivity(
    kind: VoiceActivityItem["kind"],
    title: string,
    detail?: string,
  ): void {
    this.callbacks.onActivity({
      id: makeActivityId(),
      createdAt: new Date().toISOString(),
      kind,
      title,
      ...(detail ? { detail } : {}),
    });
  }

  async connect(settings: GeminiLiveSettings): Promise<void> {
    const apiKey = settings.apiKey.trim();
    if (!apiKey) {
      this.setStatus("error", "Enter your Gemini API key in Voice Settings to start.");
      return;
    }

    this.disconnect();
    this.setupCompleted = false;
    this.setStatus("connecting");

    this.player = new GeminiAudioPlayer({
      onSpeakingChange: (speaking) => {
        this.isSpeakingAudio = speaking;
        if (this.status === "idle" || this.status === "error" || this.status === "connecting") {
          return;
        }
        if (speaking) {
          this.setStatus("speaking");
        } else if (this.status === "speaking") {
          this.setStatus("listening");
        }
      },
      onLevelChange: (level) => {
        this.callbacks.onOutputLevelChange(level);
      },
    });

    const modelName = settings.model.startsWith("models/")
      ? settings.model
      : `models/${settings.model}`;
    const url = `${GEMINI_LIVE_WS_BASE_URL}?key=${encodeURIComponent(apiKey)}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      const snapshot = this.callbacks.getToolHandlers().getThreadStatus();
      const contextSummary = [
        SYSTEM_INSTRUCTION_TEXT,
        "",
        `Current T3 Code Context: Project="${snapshot.projectName ?? "None"}", Thread="${snapshot.threadTitle}", AgentWorking=${snapshot.isWorking}.`,
      ].join("\n");

      const setupPayload = {
        setup: {
          model: modelName,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: settings.voiceName,
                },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: contextSummary }],
          },
          tools: GEMINI_LIVE_TOOLS,
        },
      };
      ws.send(JSON.stringify(setupPayload));
    };

    ws.onmessage = async (event: MessageEvent) => {
      if (this.ws !== ws) return;
      try {
        const rawText =
          event.data instanceof Blob ? await event.data.text() : String(event.data);
        const message = JSON.parse(rawText) as GeminiServerMessage;
        await this.handleServerMessage(message);
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Failed to parse server frame";
        this.emitActivity("system", "Voice protocol warning", detail);
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.setStatus("error", "Gemini Live WebSocket error. Check your API key and model.");
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return;
      this.stopAudioPipelines();
      this.ws = null;
      if (event.code !== 1000 && this.status !== "idle") {
        const reason = event.reason || `Connection closed (code ${event.code})`;
        this.setStatus("error", reason);
        this.emitActivity("system", "Voice session disconnected", reason);
      } else {
        this.setStatus("idle");
      }
    };
  }

  private async handleServerMessage(message: GeminiServerMessage): Promise<void> {
    if (message.setupComplete !== undefined && !this.setupCompleted) {
      this.setupCompleted = true;
      await this.startMicPipeline();
      this.setStatus("listening");
      this.emitActivity("system", "Gemini Live connected - listening");
      return;
    }

    if (message.serverContent) {
      const { interrupted, modelTurn, turnComplete } = message.serverContent;
      if (interrupted) {
        this.player?.interrupt();
        this.setStatus("listening");
      }

      if (modelTurn?.parts) {
        const textFragments: string[] = [];
        for (const part of modelTurn.parts) {
          if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/pcm")) {
            this.player?.enqueuePcm16Base64(part.inlineData.data, 24000);
          }
          if (part.text && part.text.trim()) {
            textFragments.push(part.text.trim());
          }
        }
        if (textFragments.length > 0) {
          this.emitActivity("assistant", "Voice response", textFragments.join(" "));
        }
      }

      if (turnComplete && !this.isSpeakingAudio && this.status !== "executing_tool") {
        this.setStatus("listening");
      }
    }

    if (message.toolCall?.functionCalls && message.toolCall.functionCalls.length > 0) {
      this.setStatus("executing_tool");
      const handlers = this.callbacks.getToolHandlers();
      const functionResponses: Array<{
        id: string;
        name: string;
        response: Record<string, unknown>;
      }> = [];

      for (const call of message.toolCall.functionCalls) {
        try {
          if (call.name === "send_message_to_agent") {
            const prompt = typeof call.args?.prompt === "string" ? call.args.prompt.trim() : "";
            this.emitActivity("tool", "Sent prompt to coding agent", prompt);
            const res = await handlers.sendPromptToThread(prompt);
            functionResponses.push({
              id: call.id,
              name: call.name,
              response: { result: res },
            });
          } else if (call.name === "get_thread_status") {
            const status = handlers.getThreadStatus();
            this.emitActivity(
              "tool",
              "Checked thread status",
              `${status.threadTitle} (${status.isWorking ? "working" : "idle"})`,
            );
            functionResponses.push({
              id: call.id,
              name: call.name,
              response: { result: status },
            });
          } else if (call.name === "interrupt_agent") {
            this.emitActivity("tool", "Interrupted coding agent");
            const res = await handlers.interruptThread();
            functionResponses.push({
              id: call.id,
              name: call.name,
              response: { result: res },
            });
          } else if (call.name === "start_new_thread") {
            this.emitActivity("tool", "Started new coding thread");
            const res = await handlers.startNewThread();
            functionResponses.push({
              id: call.id,
              name: call.name,
              response: { result: res },
            });
          } else {
            functionResponses.push({
              id: call.id,
              name: call.name,
              response: { error: `Unknown tool ${call.name}` },
            });
          }
        } catch (err) {
          functionResponses.push({
            id: call.id,
            name: call.name,
            response: {
              error: err instanceof Error ? err.message : "Tool execution failed",
            },
          });
        }
      }

      this.sendJson({
        toolResponse: {
          functionResponses,
        },
      });
      if (!this.isSpeakingAudio) {
        this.setStatus("listening");
      }
    }
  }

  private async startMicPipeline(): Promise<void> {
    this.mic?.stop();
    const mic = new GeminiMicCapture();
    this.mic = mic;
    try {
      await mic.start({
        onAudioChunk: (base64Pcm16) => {
          if (!this.setupCompleted || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
          }
          this.sendJson({
            realtimeInput: {
              mediaChunks: [
                {
                  mimeType: "audio/pcm;rate=16000",
                  data: base64Pcm16,
                },
              ],
            },
          });
        },
        onLevelChange: (level) => {
          this.callbacks.onInputLevelChange(level);
        },
        onError: (err) => {
          this.setStatus("error", err.message);
          this.emitActivity("system", "Microphone error", err.message);
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Microphone permission denied";
      this.setStatus("error", msg);
    }
  }

  sendAgentUpdate(summaryText: string, eventLabel = "Coding agent finished turn"): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.setupCompleted) {
      return;
    }
    this.emitActivity("agent_update", eventLabel, summaryText.slice(0, 180));
    this.sendJson({
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [
              {
                text: `[T3_CODE_AGENT_UPDATE] (${eventLabel}) Please summarize this update naturally and briefly for the user in 1-3 spoken sentences:\n\n${summaryText}`,
              },
            ],
          },
        ],
        turnComplete: true,
      },
    });
  }

  setMuted(muted: boolean): void {
    this.mic?.setMuted(muted);
    if (muted) {
      this.callbacks.onInputLevelChange(0);
    }
  }

  isMuted(): boolean {
    return this.mic?.isMuted() ?? false;
  }

  private sendJson(payload: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private stopAudioPipelines(): void {
    this.mic?.stop();
    this.mic = null;
    this.player?.dispose();
    this.player = null;
    this.callbacks.onInputLevelChange(0);
    this.callbacks.onOutputLevelChange(0);
  }

  disconnect(): void {
    this.setupCompleted = false;
    this.stopAudioPipelines();
    if (this.ws) {
      const current = this.ws;
      this.ws = null;
      try {
        current.close(1000, "User ended voice session");
      } catch {
        // Ignore close errors.
      }
    }
    this.setStatus("idle");
  }
}
