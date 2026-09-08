---
"effect": patch
---

add support for merging external events into `Prompt.custom` render loops via an optional `events` dequeue and `receive` handler.

The prompt races user input against events from the dequeue, allowing background events to trigger re-renders without waiting for a keypress:

```ts
const eventQueue = yield * Queue.make<number>()

const prompt = Prompt.custom(
  { count: 0 },
  Queue.asDequeue(eventQueue), // <-- provide the event queue as a dequeue to the prompt
  {
    render: (state) => Effect.succeed(`Count: ${state.count}`),
    process: (input, state) =>
      Effect.succeed(
        Match.value(input).pipe(
          // handle user input
          Match.tag("Input", () => Action.Submit({ value: state.count })),
          // handle external events from the queue
          Match.tag("Event", (input) => Action.NextFrame({ state: { count: state.count + input.value } })),
          Match.exhaustive
        )
      ),
    clear: () => Effect.succeed("")
  }
)
```
