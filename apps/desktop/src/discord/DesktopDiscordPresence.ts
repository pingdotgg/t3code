// @effect-diagnostics globalTimers:off - Discord RPC reconnects from an imperative SDK callback.
import { Client } from "@xhayper/discord-rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

declare const __T3CODE_BUILD_DISCORD_APPLICATION_ID__: string | undefined;

const RETRY_DELAY_MS = 15_000;

interface DiscordRpcUser {
  readonly setActivity: (activity: { readonly details: string }) => Promise<unknown>;
  readonly clearActivity: () => Promise<unknown>;
}

export interface DiscordRpcClient {
  readonly isConnected: boolean;
  readonly user: DiscordRpcUser | undefined;
  readonly login: () => Promise<unknown>;
  readonly destroy: () => Promise<unknown>;
  readonly on: (event: "disconnected", listener: () => void) => unknown;
}

export type DiscordRpcClientFactory = (applicationId: string) => DiscordRpcClient;

export class DiscordPresenceSessionError extends Schema.TaggedErrorClass<DiscordPresenceSessionError>()(
  "DiscordPresenceSessionError",
  {
    operation: Schema.Literals(["setActivity"]),
  },
) {
  override get message(): string {
    return "Discord RPC connected without a user session while attempting to set activity.";
  }
}

export class DesktopDiscordPresence extends Context.Service<
  DesktopDiscordPresence,
  {
    readonly available: boolean;
    readonly setActiveProjectCount: (count: number) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/discord/DesktopDiscordPresence") {}

export function formatDiscordPresence(activeProjectCount: number): string {
  return `Working in T3 Code on ${activeProjectCount} ${activeProjectCount === 1 ? "project" : "projects"}`;
}

class DiscordPresenceController {
  private desiredCount = 0;
  private appliedCount: number | null = null;
  private client: DiscordRpcClient | null = null;
  private operation = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  readonly applicationId: string;
  private readonly createClient: DiscordRpcClientFactory;
  private readonly retryDelayMs: number;

  constructor(
    applicationId: string,
    createClient: DiscordRpcClientFactory,
    retryDelayMs = RETRY_DELAY_MS,
  ) {
    this.applicationId = applicationId;
    this.createClient = createClient;
    this.retryDelayMs = retryDelayMs;
  }

  setActiveProjectCount(count: number): Promise<void> {
    if (this.disposed || count === this.desiredCount) return this.operation;
    this.desiredCount = count;
    this.clearRetry();
    return this.enqueue();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.desiredCount = 0;
    this.clearRetry();
    await this.operation.catch(() => undefined);
    await this.disconnect(true);
  }

  private enqueue(): Promise<void> {
    this.operation = this.operation
      .then(() => this.reconcile())
      .catch(() => {
        this.scheduleRetry();
      });
    return this.operation;
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return;
    if (this.desiredCount === 0) {
      await this.disconnect(true);
      return;
    }
    if (!this.applicationId) return;

    if (!this.client?.isConnected) {
      await this.disconnect(false);
      const client = this.createClient(this.applicationId);
      this.client = client;
      client.on("disconnected", () => {
        if (this.client !== client || this.disposed) return;
        this.appliedCount = null;
        this.scheduleRetry();
      });
      await client.login();
    }

    if (this.disposed || this.desiredCount === 0) {
      await this.disconnect(true);
      return;
    }
    if (this.desiredCount === this.appliedCount) return;

    const user = this.client?.user;
    if (!user) {
      throw new DiscordPresenceSessionError({ operation: "setActivity" });
    }
    const count = this.desiredCount;
    await user.setActivity({ details: formatDiscordPresence(count) });
    this.appliedCount = count;
  }

  private async disconnect(clearActivity: boolean): Promise<void> {
    const client = this.client;
    this.client = null;
    this.appliedCount = null;
    if (!client) return;

    if (clearActivity && client.isConnected && client.user) {
      await client.user.clearActivity().catch(() => undefined);
    }
    await client.destroy().catch(() => undefined);
  }

  private scheduleRetry(): void {
    if (this.disposed || this.desiredCount === 0 || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.enqueue();
    }, this.retryDelayMs);
  }

  private clearRetry(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

export function make({
  applicationId,
  createClient = (clientId) => new Client({ clientId }),
  retryDelayMs,
}: {
  readonly applicationId: string;
  readonly createClient?: DiscordRpcClientFactory;
  readonly retryDelayMs?: number;
}) {
  return Effect.acquireRelease(
    Effect.sync(
      () => new DiscordPresenceController(applicationId.trim(), createClient, retryDelayMs),
    ),
    (controller) => Effect.promise(() => controller.dispose()),
  ).pipe(
    Effect.map((controller) =>
      DesktopDiscordPresence.of({
        available: controller.applicationId.length > 0,
        setActiveProjectCount: (count) =>
          Effect.promise(() => controller.setActiveProjectCount(count)),
      }),
    ),
  );
}

const applicationId =
  typeof __T3CODE_BUILD_DISCORD_APPLICATION_ID__ === "undefined"
    ? ""
    : __T3CODE_BUILD_DISCORD_APPLICATION_ID__;

export const layer = Layer.effect(DesktopDiscordPresence, make({ applicationId }));
