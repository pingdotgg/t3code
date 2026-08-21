# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

On mobile, **Settings → General → Steer active turns** controls messages sent while an agent is
working. Leave it on to steer the active turn immediately. Turn it off to store the message on the
server and run it after the active turn finishes. Server-queued messages remain visible in the
thread and can be cancelled before they start, even if the mobile app disconnects.

If the server restarts during the narrow handoff to a provider, T3 Code reports the delivery as
interrupted instead of replaying it automatically, because the provider may already have received
the message. Check the provider transcript before resending it.
