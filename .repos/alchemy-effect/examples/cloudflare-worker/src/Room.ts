import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Ephemeral chat room: broadcasts each text message to every connected client.
 * Uses Durable Object storage of WebSocket attachments so sessions survive hibernation.
 *
 * Also demonstrates scheduled events: send `/remind <seconds> <message>` to
 * schedule a broadcast that fires after the given delay.
 */
export default class Room extends Cloudflare.DurableObjectNamespace<Room>()(
  "Rooms",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      const sessions = new Map<string, Cloudflare.DurableWebSocket>();

      for (const socket of yield* state.getWebSockets()) {
        const attachment = socket.deserializeAttachment<{ id: string }>();
        if (attachment) {
          sessions.set(attachment.id, socket);
        }
      }

      const broadcast = (text: string) =>
        Effect.gen(function* () {
          for (const peer of sessions.values()) {
            yield* peer.send(text);
          }
        });

      return {
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          const id = crypto.randomUUID();
          socket.serializeAttachment({ id });
          sessions.set(id, socket);
          return response;
        }),
        broadcast,
        alarm: () =>
          Effect.gen(function* () {
            const fired = yield* Cloudflare.processScheduledEvents;
            for (const event of fired) {
              const payload = event.payload as { message: string };
              yield* broadcast(`[reminder] ${payload.message}`);
            }
          }),
        webSocketMessage: Effect.fnUntraced(function* (
          socket: Cloudflare.DurableWebSocket,
          message: string | ArrayBuffer,
        ) {
          const attachment = socket.deserializeAttachment<{ id: string }>();
          if (!attachment) return;
          const text =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);

          const remindMatch = text.match(/^\/remind\s+(\d+)\s+(.+)$/);
          if (remindMatch) {
            const delaySec = parseInt(remindMatch[1], 10);
            const msg = remindMatch[2];
            const id = crypto.randomUUID();
            const runAt = new Date(Date.now() + delaySec * 1000);
            yield* Cloudflare.scheduleEvent(id, runAt, { message: msg });
            yield* socket.send(
              `[system] Reminder scheduled in ${delaySec}s: "${msg}"`,
            );
            return;
          }

          const label = attachment.id.slice(0, 8);
          for (const peer of sessions.values()) {
            yield* peer.send(`[${label}] ${text}`);
          }
        }),
        webSocketClose: Effect.fnUntraced(function* (
          ws: Cloudflare.DurableWebSocket,
          code: number,
          reason: string,
          _wasClean: boolean,
        ) {
          const attachment = ws.deserializeAttachment<{ id: string }>();
          if (attachment) {
            sessions.delete(attachment.id);
          }
          yield* ws.close(code, reason);
        }),
      };
    });
  }),
) {}
