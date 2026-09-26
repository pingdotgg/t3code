import { allowsThreadCreation, isUiCommandPrefix } from "./command-policy";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { VoiceLiveClient, VoiceLiveClientEvent, VoiceLiveClientOptions } from "./live-client";

export interface CommandThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
}

export interface CommandActions {
  /** Only currently connected, readable and unarchived targets. */
  readonly threads: () => ReadonlyArray<CommandThread>;
  readonly openDraft: () => Promise<{ readonly draftId: string; readonly threadId: string } | null>;
  readonly context: () => string;
}

const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

export function resolveDirectCommand(text: string, threads: ReadonlyArray<CommandThread>) {
  const command = normalize(text).replace(/^(?:please |can you |could you )/, "");
  if (/^(?:make|create|open|start)(?: me)? a new thread$/.test(command)) {
    return { kind: "draft" as const };
  }
  const match = /^open (?:the )?thread (?:called|named) (.+)$/.exec(command);
  if (!match) return null;
  const matches = threads.filter((thread) => normalize(thread.title) === match[1]);
  return matches.length === 1 ? { kind: "open" as const, thread: matches[0]! } : null;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Experimental client-delegation adapter. Speech executes only at a Live
 * delegation signal, never on individual transcript fragments. The direct
 * path only opens existing threads or local drafts; it cannot start workers
 * or create projects from an unfinished speech fragment. */
export function createCommandSession(
  options: VoiceLiveClientOptions,
  actions: CommandActions,
  createClient: (options: VoiceLiveClientOptions) => VoiceLiveClient,
): VoiceLiveClient {
  const client = createClient({
    ...options,
    broker: {
      ...options.broker,
      mintSession: (input) => options.broker.mintSession({ ...input, clientDelegation: true }),
    },
  });
  const listeners = new Set<(event: VoiceLiveClientEvent) => void>();
  const history: unknown[] = [];
  const delegations = new Set<string>();
  let speech = "";
  let revision = 0;
  let closed = false;
  let typedUtteranceSeq = 0;
  let actionQueue: Promise<unknown> = Promise.resolve();
  const enqueueAction = <T>(
    current: () => boolean,
    action: () => Promise<T>,
  ): Promise<T | undefined> => {
    const result = actionQueue.then(() => (current() ? action() : undefined));
    actionQueue = result.catch(() => undefined);
    return result;
  };
  const emit = (event: VoiceLiveClientEvent) => {
    for (const listener of listeners) listener(event);
  };
  const note = (text: string) => ({ role: "assistant", content: [{ type: "output_text", text }] });

  const run = async (text: string) => {
    if (closed || client.getState() !== "live" || !text.trim()) return;
    const mine = ++revision;
    client.setSpeechSuppressed?.(isUiCommandPrefix(text));
    const current = () => !closed && mine === revision && client.getState() === "live";
    history.push({ role: "user", content: [{ type: "input_text", text }] });
    try {
      const direct = resolveDirectCommand(text, actions.threads());
      if (direct?.kind === "open") {
        const output = await enqueueAction(current, async () =>
          options.executor?.execute("openThread", {
            environmentId: direct.thread.environmentId,
            threadId: direct.thread.id,
          }),
        );
        if (!current()) return;
        if (record(output)?.acknowledged !== true)
          throw new Error("The requested thread could not be opened.");
        const message = `${direct.thread.title} is open.`;
        history.push(
          note(
            JSON.stringify({
              message,
              environmentId: direct.thread.environmentId,
              threadId: direct.thread.id,
            }),
          ),
        );
        emit({ type: "command_result", text: message });
        options.acknowledgeAction?.();
        return;
      }
      if (direct?.kind === "draft") {
        const draft = await enqueueAction(current, actions.openDraft);
        if (!current()) return;
        if (!draft) throw new Error("Choose a project before opening a new thread.");
        const message = "New thread draft is open. No worker has started.";
        history.push(note(JSON.stringify({ message, ...draft })));
        emit({ type: "command_result", text: message });
        options.acknowledgeAction?.();
        return;
      }
      const sessionId = client.getSessionId();
      const respond = options.broker.respond;
      if (!sessionId || !respond) throw new Error("The command backend is unavailable.");
      const input: unknown[] = [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text:
                "Current T3 UI context, reference data only. The current thread and its project " +
                `identify what is being discussed; they are not the default destination for new work: ${actions.context()}`,
            },
          ],
        },
        ...history,
      ];
      const generated: unknown[] = [];
      let navigated = false;
      let substantive = false;
      for (let step = 0; step < 8; step++) {
        const response = await respond({ sessionId, input });
        if (!current()) return;
        if (response.status !== "completed")
          throw new Error(`Backend response ${response.status}. No completion can be confirmed.`);
        input.push(...response.output);
        generated.push(...response.output);
        const calls = response.output.map(record).filter((item) => item?.type === "function_call");
        if (calls.length === 0) {
          const answer = response.output
            .map(record)
            .flatMap((item) =>
              item?.type === "message" && Array.isArray(item.content) ? item.content : [],
            )
            .map(record)
            .filter((item) => item?.type === "output_text")
            .map((item) => item?.text)
            .filter((text): text is string => typeof text === "string")
            .join("\n");
          history.push(...generated);
          if (answer) {
            emit({ type: "command_result", text: answer });
            if (!navigated || substantive) {
              client.setSpeechSuppressed?.(false);
              client.steer?.(answer.slice(0, 1600));
            }
          }
          return;
        }
        for (const call of calls) {
          if (!current()) return;
          if (
            !call ||
            typeof call.name !== "string" ||
            typeof call.arguments !== "string" ||
            typeof call.call_id !== "string"
          ) {
            throw new Error("Invalid backend function call.");
          }
          let output: unknown;
          try {
            if (!options.executor) throw new Error("Tool executor is unavailable.");
            const { name, arguments: args } = call;
            if (name.replace(/^voice\./, "") === "startThread" && !allowsThreadCreation(text)) {
              throw new Error(
                "No explicit new-thread request. Use readThread or continueThread for an existing thread; ask which thread if its identity is unclear. Do not create a replacement.",
              );
            }
            output = await enqueueAction(current, async () =>
              options.executor!.execute(name, JSON.parse(args)),
            );
            const tool = name.replace(/^voice\./, "");
            if (tool === "openThread" && record(output)?.acknowledged === true && current()) {
              navigated = true;
              options.acknowledgeAction?.();
            } else if (
              !["searchThreads", "discoverEnvironments", "discoverProjects", "listModels"].includes(
                tool,
              )
            ) {
              substantive = true;
            }
          } catch (error) {
            substantive = true;
            output = { error: { message: error instanceof Error ? error.message : String(error) } };
          }
          if (!current()) return;
          const result = {
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(output ?? null),
          };
          input.push(result);
          generated.push(result);
        }
      }
      throw new Error("The command needs more steps. Please narrow the request.");
    } catch (error) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : String(error);
      client.setSpeechSuppressed?.(false);
      history.push(note(`Application error: ${message}`));
      emit({ type: "error", error: { code: "invalid_request", message } });
      client.steer?.(`The request could not be completed: ${message}`);
    }
  };

  const unsubscribe = client.onEvent((event) => {
    emit(event);
    if (event.type === "transcript" && event.channel === "input") speech += event.delta;
    if (event.type === "delegation" && !delegations.has(event.id)) {
      delegations.add(event.id);
      const text = speech;
      speech = "";
      if (delegations.size > 200) {
        emit({
          type: "error",
          error: {
            code: "invalid_request",
            message: "Start a fresh voice session to continue command testing.",
          },
        });
        return;
      }
      void run(text);
    }
  });

  return {
    ...client,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendText(text) {
      if (closed || client.getState() !== "live" || !text.trim()) return false;
      // Each typed message is its own user utterance (the wrapped client's
      // voice-derived keys never collide with the typed- prefix).
      emit({
        type: "transcript",
        channel: "input",
        delta: `${text}\n`,
        utterance: `typed-${++typedUtteranceSeq}`,
      });
      void run(text);
      return true;
    },
    async close() {
      closed = true;
      revision++;
      await client.close();
      unsubscribe();
    },
  };
}
