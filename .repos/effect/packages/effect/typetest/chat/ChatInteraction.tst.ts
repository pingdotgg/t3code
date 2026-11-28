import { Context, Effect, type Layer, Schema } from "effect"
import { ChatInteraction } from "effect/chat"
import { describe, expect, it } from "tstyche"

const EnvId = Schema.String.pipe(Schema.brand("EnvId"))
type EnvId = typeof EnvId.Type

class DeployQueue extends Context.Service<DeployQueue, {
  readonly offer: (item: unknown) => Effect.Effect<void>
}>()("DeployQueue") {}

const Deploy = Schema.Struct({ version: Schema.String })

const Approve = ChatInteraction.button("approve", { label: "Approve", value: Deploy })
const Refresh = ChatInteraction.button("refresh", { label: "Refresh" })
const PickEnv = ChatInteraction.select("pick-env", { value: EnvId })
const RejectReason = ChatInteraction.modal("reject-reason", {
  title: "Reject deploy",
  metadata: Deploy,
  fields: {
    intro: ChatInteraction.text("Tell the author why."),
    reason: ChatInteraction.textInput({ label: "Reason", multiline: true }),
    note: ChatInteraction.textInput({ label: "Note", optional: true }),
    severity: ChatInteraction.choice({
      label: "Severity",
      options: [{ label: "Low", value: "low" }, { label: "High", value: "high" }]
    }),
    env: ChatInteraction.selectInput({ label: "Environment", value: EnvId })
  }
})
const Feedback = ChatInteraction.modal("feedback", {
  title: "Feedback",
  fields: { body: ChatInteraction.textInput({ label: "Feedback" }) }
})
const Ship = ChatInteraction.command("ship", { description: "Ship a version" })

describe("ChatInteraction", () => {
  it("of takes the value its schema asks for", () => {
    expect(Approve.of).type.not.toBeCallableWith()
    expect(Approve.of).type.not.toBeCallableWith({ version: 1 })
    expect(Refresh.of).type.not.toBeCallableWith({ version: "v1" })
  })

  it("open needs the metadata and the selectInput options", () => {
    expect(RejectReason.open).type.not.toBeCallableWith()
    expect(RejectReason.open).type.not.toBeCallableWith({ metadata: { version: "v1" } })
    expect(Feedback.open()).type.toBe<ChatInteraction.OpenModal>()
  })

  it("types each handler from its definition", () => {
    const Group = ChatInteraction.group(Approve, Refresh, PickEnv, RejectReason, Feedback)
    const layer = Group.toLayer(Effect.gen(function*() {
      const queue = yield* DeployQueue
      return {
        approve: (click) => {
          expect(click.value).type.toBe<{ readonly version: string }>()
          return queue.offer(click.value).pipe(Effect.as(ChatInteraction.ack))
        },
        refresh: (click) => {
          expect(click.value).type.toBe<undefined>()
          return Effect.succeed(Feedback.open())
        },
        "pick-env": (selected) => {
          expect(selected.value).type.toBe<EnvId>()
          return Effect.succeed(ChatInteraction.ack)
        },
        "reject-reason": (submit) => {
          expect(submit.values).type.toBe<{
            readonly reason: string
            readonly note: string | undefined
            readonly severity: "low" | "high"
            readonly env: EnvId
          }>()
          expect(submit.metadata).type.toBe<{ readonly version: string }>()
          return Effect.succeed(ChatInteraction.errors({ reason: "Say a bit more." }))
        },
        feedback: (submit) => {
          expect(submit.metadata).type.toBe<undefined>()
          return Effect.succeed(ChatInteraction.close)
        }
      }
    }))
    expect(layer).type.toBe<Layer.Layer<never, never, DeployQueue | ChatInteraction.Registry>>()
  })

  it("refuses a missing handler, a failing handler, a reply of the wrong kind and an error for an unknown field", () => {
    const Group = ChatInteraction.group(Approve, RejectReason, Ship)
    const valid = {
      approve: () => Effect.succeed(ChatInteraction.ack),
      "reject-reason": () => Effect.succeed(ChatInteraction.close),
      ship: (command: ChatInteraction.CommandInvoked) => Effect.succeed(ChatInteraction.defer(command))
    }
    expect(Group.toLayer(valid)).type.toBe<Layer.Layer<never, never, ChatInteraction.Registry>>()
    const { ship: _, ...missing } = valid
    expect(Group.toLayer).type.not.toBeCallableWith(missing)
    expect(Group.toLayer).type.not.toBeCallableWith({ ...valid, ship: () => Effect.fail("boom") })
    expect(Group.toLayer).type.not.toBeCallableWith({ ...valid, approve: () => Effect.succeed(ChatInteraction.close) })
    expect(Group.toLayer).type.not.toBeCallableWith({
      ...valid,
      "reject-reason": () => Effect.succeed(Feedback.open())
    })
    expect(Group.toLayer).type.not.toBeCallableWith({ ...valid, ship: () => Effect.succeed(ChatInteraction.ack) })
    expect(Group.toLayer).type.not.toBeCallableWith({
      ...valid,
      "reject-reason": () => Effect.succeed(ChatInteraction.errors({ intro: "A text has no error." }))
    })
  })
})
