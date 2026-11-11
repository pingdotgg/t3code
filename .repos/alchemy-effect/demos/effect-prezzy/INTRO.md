# Intro design: a programming language for the cloud

The intro runs before chapter 0. It tells the story of why Alchemy exists
and how it works, then hands over to the demo. Like the demo chapters,
every numbered step is one press of →: one visual change, one caption.
Captions are in **bold**; the rest is what's on screen and what to say.

Code on screen is real: every Alchemy/Effect snippet lives in
`intro/snippets/*.ts`, type-checks against the repo, and type errors are
the real `tsc` messages. Pseudo-code (the imagined language) is marked as
such on screen.

## Act 1: A programming language for the cloud

1. **A programming language for the cloud**
   Title slide. Subtitle: "…without building a new language. Yet."

2. **A cloud program describes a world that outlives it**
   Split screen. Left: an ordinary program as a timeline, entry → exit,
   state gone. Right: a cloud program, where each run leaves behind a
   persistent world (Functions, Databases, Buckets) that the next run must
   start from.

3. **That world is a graph of resources**
   The right-hand world becomes a graph: Function, Database, Bucket,
   Queue nodes animate in, then the edges between them.

4. **Resources change over time: reconciliation**
   Zoom into one Bucket node. Its config card steps v1 → v2 → v3
   (versioning on, CORS added, lifecycle rule). Each change shows
   *desired* vs *actual* and a "reconcile" arrow converging them.

5. **Connecting resources means permissions and configuration**
   Zoom into the Function → Bucket edge. It expands into what it really
   is: an IAM policy statement (`s3:GetObject` on the bucket ARN) and an
   environment variable (`BUCKET_NAME`). Label the whole thing: a
   **binding**.

6. **A cloud language could infer all of this from the code**
   Pseudo-code: a function body calling `bucket.get(key)`. Hand-drawn
   arrows from `bucket.get` to the inferred policy statement and to the
   injected environment variable.

## Act 2: Programs that run in phases

7. **Cloud programs run in two phases**
   Two columns. *Construction*: declarative, builds the static
   architecture: resources and bindings. *Runtime*: dynamic, imperative:
   requests, jobs, data, API calls. A timeline underneath: construct once,
   runtime many times.

8. **Runtime is written in terms of construction**
   The two columns connect: runtime code points back at the resources and
   bindings construction declared.

9. **Imagine colored functions**
   Pseudo-code, lines tinted by phase:
   ```
   construct storage() {
     const bucket = Bucket()
     return {
       runtime get(key) => bucket.get(key)
     }
   }
   ```
   `construct` lines in one colour, `runtime` lines in another.

10. **The colors are enforced boundaries**
    Draw on it: a `runtime` function calling `Bucket()` gets a red
    strike-through and "can't construct at runtime"; the reverse gets the
    same.

11. **Inferring bindings is type checking**
    The `get(key)` line is circled; beside it, the analysis: "over every
    possible `key`, `get` can call `s3:GetObject` on this bucket", which
    becomes the policy. It's the same shape of reasoning as inferring a
    return type.

## Act 3: How we tried before

12. **I've tried this before**
    Timeline slide: Punchcard (2018/19, on the AWS CDK) → Functionless (2022) →
    Alchemy.

13. **Punchcard: two phases on top of the AWS CDK**
    A real Punchcard snippet (pulled from github.com/sam-goodwin/punchcard).
    Then a bar grows beside it: the runtime bundle, dragging the whole CDK
    along. **Runtime code shipped with all of the infrastructure code**

14. **Functionless: read the code's own AST at runtime**
    A function, then its AST tree unfolding, walking into variables
    captured from the lexical scope to find the resources it touches.
    Annotate: bundling hacks to make the AST available.

15. **A square peg in a round hole**
    Section slide. Both approaches bent a language into doing something it
    was never designed to do.

## Act 4: Effect is the missing piece

16. **Effect<A, Err, Req>**
    The type signature, large. Each parameter lights up in turn with its
    label: success, errors, and…

17. **Req: what a function needs from the outside world**
    `Req` stays lit: an ordinary signature says what goes in and comes
    out; `Req` says what the function *depends on*.

18. **Static analysis needs to see inside a function**
    A function with a hidden call to the bucket inside its body. A
    magnifying glass tries to peek in; annotate "breaks encapsulation".

19. **So lift it into the type instead**
    Morph animation: the hidden dependency slides out of the body and into
    the signature, `Effect<Buffer, NoSuchKey, GetObject>`. This is what
    type systems are for.

20. **Context.Service and Layer separate interface from implementation**
    Diagram: a `Context.Service` (the interface) on one side, a `Layer`
    (the implementation) on the other, joined only at `Effect.provide`.
    Callout back to step 13: this is exactly what Punchcard couldn't do.

21. **A resource's provider is required only by the Stack**
    Real code: `yield* Bucket("Uploads")` inside a Worker. Its provider
    requirement travels up the type, past the Worker, and is satisfied by
    `Alchemy.Stack`'s `providers`. Two boxes: *Stack (deploy time only)*
    holds the providers; *Worker bundle* contains none of them.

22. **A binding is a declaration**
    Real code: `const getObject = yield* AWS.S3.GetObject(bucket)`.
    Highlight: it says *what* the Worker may do, not *how*.

23. **The type system makes you provide an implementation**
    Remove `Effect.provide(AWS.S3.GetObjectHttp)`: the real `tsc` error
    appears as a red squiggle. Put it back: the error clears. `Http` is
    the implementation's name: Alchemy's Distilled SDK over HTTP.

24. **The implementation wires up permissions too**
    The `GetObjectHttp` layer forks by host. On Lambda: a least-privilege
    statement added to the Function's IAM role. On a Cloudflare Worker (or
    anywhere outside AWS): an IAM user that may assume a role, and its keys
    bound to the Worker for short-lived credentials.

25. **Least privilege, by construction**
    A Worker's policy panel beside its code. Add `GetItem`: one line of
    code, one new statement. You can't call an API you didn't declare, so
    permissions grow with the application, and never ahead of it.

## Act 5: alchemy deploy is the compiler

26. **alchemy deploy is the compiler, without static analysis**
    Pipeline: TypeScript checks the phases and requirements
    (`Effect<A, Err, Req>`, `Layer<Out, Err, In>`) → running the program
    builds the graph of resources and bindings → the graph is diffed into
    a plan you review → apply.

## Act 6: Components that include their runtime

27. **Infrastructure components have existed for years**
    Terraform modules, CDK constructs, Pulumi components, drawn as boxes
    full of infrastructure.

28. **But they can't include the code that uses them**
    The runtime code sits outside each box. You can't ship an
    application-facing component that brings its own infrastructure.

29. **In Alchemy, a component is just a Layer**
    Real code: a `Links` `Context.Service` interface; a `Layer.effect`
    that declares a table and its bindings in the construction phase and
    returns the runtime interface.

30. **Swap the infrastructure, keep the business logic**
    The Layer behind `Links` cycles S3 → R2 → DynamoDB → Neon; the
    business logic above it doesn't change. (Chapter 6 of the demo does
    this for real.)

## Act 7: The colors, in the type system

31. **The phases are real, and TypeScript can check them**
    Back to the colored-function pseudo-code, faded. Beside it, the real
    Alchemy equivalent.

32. **Runtime calls need RuntimeContext**
    Real code: inside a Worker's constructor, bind `GetObject` and call it
    immediately. Red squiggle, with the real `tsc` error: the constructor
    runs at deploy time too, and `RuntimeContext` isn't available there.

33. **An escape hatch, like ts-expect-error**
    `Effect.provide(Alchemy.RuntimeContext.phantom)` squashes it: an
    explicit opt-in, visible in review.

34. **Today a DSL, tomorrow a syntax**
    Morph between the Effect code and the colored-function pseudo-code:
    the same program. The TypeScript + Effect DSL is the foundation a
    real syntax could sit on later.

35. **Let's build something**
    Transition slide into chapter 0.

## What this needs from the renderer

- **Code slides with steps**: Shiki-highlighted code where each step can
  reveal lines, tint lines by phase, dim everything but a range, and
  morph one snippet into another (tokens that survive glide to their new
  place; new ones fade in).
- **Drawing on code**: hand-drawn circles, underlines, strike-throughs and
  arrows to callout labels, drawn stroke by stroke (rough.js, MIT
  licensed).
- **Real type errors**: a red squiggle under a range with an editor-style
  error tooltip, text taken from `tsc` on the snippet.
- **Diagram slides**: the demo's node/edge style, with edges that expand
  into their grant (policy JSON, env vars).
- **Timeline, split-screen, pipeline and type-signature layouts.**
- Authoring: `intro.ts` lists the steps with typed specs, and render
  splits the intro into one presenter step per item, like the chapters.

Rough length: 35 steps, about 8–10 minutes of talking.
