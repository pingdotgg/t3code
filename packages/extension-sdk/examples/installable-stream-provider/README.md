# Shared counter stream provider

A format-3 package with its own write API and read-only snapshot stream. Install this directory on the target environment with a project grant, then open Shared counter. Increment is an explicit authorized write; subscribing cannot mutate the counter.

The package owns a bounded, coalescing state stream. It retains one latest snapshot per subscriber rather than every intermediate increment. The project counter survives view reload while its worker remains alive. It is intentionally in-memory example state: disabling, updating, or restarting the worker resets the counter and changes its epoch. It is not a durable resource service.

Install the adjacent installable-stream-consumer package and open Mirrored counter in a second view/client. That package runs in a separate worker and consumes this API through its declared dependency and session.subscribeApi, then exposes its own stream. Neither package imports private app code or opens a socket.

Required proof: increment through the provider view and observe the separate consumer; revoke the consumer project grant during a pending next; disable/remove the provider and check dependency unavailability; regrant/reinstall and explicitly resubscribe. Package validation or direct broker fixtures alone do not prove these operations.
