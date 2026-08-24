import type { SourceControlSshPasswordPromptRequest } from "@t3tools/contracts";

export type PresentedSshPasswordPromptRequest = SourceControlSshPasswordPromptRequest & {
  readonly receivedAtMs: number;
};

type PendingSshPasswordPrompt = {
  readonly owner: symbol;
  readonly request: PresentedSshPasswordPromptRequest;
  readonly resolve: (password: string | null) => void;
};

export interface SshPasswordPromptSession {
  readonly request: (request: SourceControlSshPasswordPromptRequest) => Promise<string | null>;
  readonly cancel: () => void;
}

export function createSshPasswordPromptBroker() {
  let pending: PendingSshPasswordPrompt[] = [];
  let subscriber: ((request: PresentedSshPasswordPromptRequest | null) => void) | null = null;

  const publishCurrent = () => {
    subscriber?.(pending[0]?.request ?? null);
  };

  const createSession = (): SshPasswordPromptSession => {
    const owner = Symbol("ssh-password-prompt-session");
    let cancelled = false;

    return {
      request: (request) =>
        new Promise((resolve) => {
          if (cancelled || subscriber === null) {
            resolve(null);
            return;
          }
          const wasEmpty = pending.length === 0;
          pending.push({
            owner,
            request: { ...request, receivedAtMs: Date.now() },
            resolve,
          });
          if (wasEmpty) {
            publishCurrent();
          }
        }),
      cancel: () => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        const current = pending[0];
        const cancelledPrompts = pending.filter((prompt) => prompt.owner === owner);
        pending = pending.filter((prompt) => prompt.owner !== owner);
        for (const prompt of cancelledPrompts) {
          prompt.resolve(null);
        }
        if (pending[0] !== current) {
          publishCurrent();
        }
      },
    };
  };

  const resolveCurrent = (requestId: string, password: string | null): void => {
    const current = pending[0];
    if (current?.request.requestId !== requestId) {
      return;
    }
    pending = pending.slice(1);
    current.resolve(password);
    publishCurrent();
  };

  const subscribe = (
    nextSubscriber: (request: PresentedSshPasswordPromptRequest | null) => void,
  ): (() => void) => {
    subscriber = nextSubscriber;
    publishCurrent();
    return () => {
      if (subscriber === nextSubscriber) {
        subscriber = null;
      }
    };
  };

  return { createSession, resolveCurrent, subscribe } as const;
}

export const sshPasswordPromptBroker = createSshPasswordPromptBroker();
