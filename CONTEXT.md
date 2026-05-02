# AI Engineer

This context describes the product domain for an AI engineer that accepts delegated software work, coordinates coding-agent execution, and reports progress back to its operators.

## Language

**AI Engineer**:
The product that accepts delegated software engineering work and drives it through execution, review, and handoff.
_Avoid_: coding-agent GUI, agent wrapper, Devin clone

**AI Engineering Team**:
The product direction where the AI Engineer can advance many independent Tasks at once by allocating separate Sandboxes and Threads per Task.
_Avoid_: parallel attempts, multi-agent race, local agent queue

**Organization**:
The company or group of humans that uses the AI Engineer together.
_Avoid_: workspace account, Slack org, tenant, Team

**T3 Code**:
The open-source coding system this product is forked from and continues to build on.
_Avoid_: AI Engineer, Orchestrator

**Orchestrator**:
The brain of the AI Engineer that decides how work is interpreted, assigned, executed, monitored, and reported.
_Avoid_: T3 Code, worker, provider

**Task State**:
The Orchestrator-owned record of a Task's identity, status, Team App links, mute state, and current Primary Thread.
_Avoid_: execution run, provider state, local thread state

**Coding Agent**:
An AI coding system such as Codex, Claude Code, or OpenCode that performs work inside Threads.
_Avoid_: provider, model, computer

**Default Coding Agent**:
The organization-wide Coding Agent used by the Orchestrator for Threads.
_Avoid_: per-project agent, auto-selected agent, provider routing

**Task**:
One delegated piece of software engineering work that the AI Engineer is responsible for advancing to a useful handoff.
_Avoid_: assignment, job, issue, run, thread

**Worktree**:
The isolated coding workspace where the AI Engineer performs the work for a Task.
_Avoid_: project folder, branch folder, session folder

**Cloud Worktree**:
A Worktree created inside a Cloud Sandbox instead of on the Operator's local machine.
_Avoid_: local worktree, remote repo clone, disposable folder

**Worktree Title**:
The human-readable name shown for a Task's Worktree in the Workspace.
_Avoid_: branch name, filesystem path, slug

**Worktree Branch**:
The git branch associated with a Task's Worktree.
_Avoid_: Task title, Worktree Title, Project

**Archived Worktree**:
A completed Worktree kept in the Workspace for history after its Task is Done.
_Avoid_: deleted worktree, closed task, finished thread

**Thread**:
A T3 Code conversation inside a Worktree where the AI Engineer builds, analyzes, reviews, or iterates on code.
_Avoid_: task, run, Slack thread

**Work Session**:
One bounded period that starts when a Coding Agent begins working in a T3 Code Thread.
_Avoid_: attempt, execution run, provider session, user-facing status

**Conversation**:
A pre-Task exchange between humans and the AI Engineer that may or may not become coding work.
_Avoid_: Thread, Task, Slack thread

**Repo-Grounded Work**:
Work that requires inspecting, changing, validating, or making recommendations about a Project's codebase.
_Avoid_: chat, brainstorming, general advice

**Task Status**:
The product-level lifecycle state of a Task.
_Avoid_: Linear status, provider status, run status

**Primary Thread**:
The Thread the Orchestrator uses to relay human messages, Task status, completed work, and final handoff.
_Avoid_: main chat, status thread, control thread

**Project**:
A repository or codebase root known to the AI Engineer.
_Avoid_: task, workspace, repo folder

**Workspace**:
The AI Engineer's native web UI where humans view and manage Projects, Worktrees, Threads, and External Links.
_Avoid_: Team App, worktree, dashboard

**Sandbox**:
The isolated execution environment where the AI Engineer works on Tasks before human review.
_Avoid_: production, operator machine, Team App

**Local Sandbox**:
A Sandbox running on the Operator's machine.
_Avoid_: default sandbox, real sandbox, local thread

**Cloud Sandbox**:
A Sandbox running in managed cloud infrastructure with its own Worktree, dependencies, runtime processes, and deferred browser access.
_Avoid_: remote session, worker, container

**Sandbox Provider**:
The runtime adapter that allocates, starts, observes, and tears down Sandboxes for the Orchestrator.
_Avoid_: coding agent provider, model provider, deployment target

**Sandbox Snapshot**:
A prebuilt filesystem and dependency state used to start Cloud Sandboxes quickly for a Project.
_Avoid_: cache, image, clone template

**Sandbox Services**:
The per-Task runtime services attached to a Sandbox, such as a Convex deployment, dev server, database, browser, or terminal.
_Avoid_: production services, integrations, external links

**Intake Source**:
A Team App or system event that can create or update a Task, such as an email to `help@nextcard.com`, a Linear issue, a Slack thread, or a GitHub event.
_Avoid_: trigger, webhook, source app

**Team App**:
An everyday collaboration app where humans work together and the AI Engineer can participate.
_Avoid_: tool, integration, surface, interface

**v1 Team App**:
A Team App included in the initial AI Engineer product boundary.
_Avoid_: future app, example app, all integrations

**External Link**:
A platform object attached to a Worktree, such as a Linear issue, Slack thread, or GitHub pull request.
_Avoid_: task, source, thread

**Muted Team App Thread**:
A linked Team App thread where the Orchestrator no longer responds to ambient messages.
_Avoid_: archived thread, disabled Task, blocked Task

**Aside Message**:
A human message in a linked Team App thread that the Orchestrator should ignore.
_Avoid_: muted thread, hidden message, deleted message

**Pull Request**:
The GitHub review artifact for a Task's Worktree.
_Avoid_: final output, Task, review status

**Draft Pull Request**:
A Pull Request opened before the Task is ready for human review.
_Avoid_: final PR, review request, Task status

**Operator**:
A technical human who supervises the AI Engineer and has authority over execution decisions.
_Avoid_: user, admin, owner

**Teammate**:
A non-technical or less-technical collaborator who can delegate or discuss Tasks without owning execution details.
_Avoid_: user, customer, stakeholder

## Relationships

- The **AI Engineer** is built on top of **T3 Code**.
- The **AI Engineering Team** is the long-term direction for the **AI Engineer**.
- The **AI Engineering Team** increases useful concurrency by assigning independent **Tasks** to independent **Sandboxes**, not by racing many attempts for one prompt.
- An **Organization** has many **Projects**.
- A Slack org links to one **Organization**.
- A Linear workspace links to one **Organization**.
- A GitHub organization or account links to one **Organization**.
- This repo targets one internal **Organization** for now.
- **Organization** is product language for the internal account boundary, not a requirement that every v1 table carry an organization identifier.
- The **Orchestrator** is a part of the **AI Engineer**.
- The **Orchestrator** owns **Task State**.
- The **Orchestrator** owns the Project registry used for Task routing.
- `apps/orchestrator` should use **Task** domain terms instead of preserving the current Linear-MVP `controlThread` and `executionRun` terminology.
- **Operators** configure **Projects** in the **Workspace**.
- The **Orchestrator** can validate or sync configured **Projects** with **T3 Code**.
- A v1 **Project** configuration includes repo name, sandbox workspace root, default branch, GitHub repo, and Linear routing when used.
- A v1 **Project** does not require Slack channel mapping.
- **T3 Code** provides the coding-agent runtime that the **Orchestrator** coordinates.
- **T3 Code** owns **Project**, **Worktree**, **Thread**, **Sandbox**, and **Coding Agent** runtime state.
- A **Sandbox** can be a **Local Sandbox** or a **Cloud Sandbox**.
- A **Sandbox Provider** supplies Sandboxes through a stable runtime interface.
- The **Orchestrator** should depend on Sandbox runtime capability, not on a specific **Sandbox Provider**.
- A **Cloud Sandbox** should be created from a **Sandbox Snapshot** when possible.
- A **Sandbox Snapshot** belongs to a **Project**.
- Product **Tasks** are created through the **Orchestrator**.
- A **Task** is represented in **T3 Code** by the **Project**, **Worktree**, **Sandbox**, and **Threads** created for that **Task**.
- The main **Workspace** sidebar shows **Orchestrator** **Tasks**, not unlinked local **T3 Code** Threads.
- v1 does not import arbitrary existing local **T3 Code** Threads into **Tasks**.
- The **Workspace** reads the Task tree from the **Orchestrator**.
- The **Workspace** uses **T3 Code** for live Thread interaction, coding output, git/worktree details, and Sandbox operations.
- The **Workspace** is implemented inside `apps/web`.
- The Task tree should be a new `apps/web` component that replaces the original flat T3 Code sidebar.
- The **Orchestrator** stores Task-level narrative events and references to T3 **Threads**.
- **T3 Code** remains the source of truth for full **Thread** transcripts and **Coding Agent** output.
- The **Orchestrator** stores current **Task State** on the Task record and important history in Task event records.
- Task event records are for timeline/audit/narrative history, not full event sourcing.
- The **Orchestrator** stores stable references and orchestration-owned fields, and derives display fields from source systems when possible.
- GitHub owns **Pull Request** title and review status when a **Pull Request** exists.
- Linear owns raw Linear issue status when a **Task** has a Linear issue **External Link**.
- The **Orchestrator** decides when a **Pull Request** should exist for a **Task**.
- **T3 Code** executes git and GitHub operations inside the **Sandbox** and reports **Pull Request** references back to the **Orchestrator**.
- The **Orchestrator** assigns **Threads** to **Coding Agents**.
- The **Orchestrator** uses the **Default Coding Agent** for Threads.
- A **Thread** keeps the **Coding Agent** it was created with.
- A human who wants a different **Coding Agent** creates a new **Thread**.
- The **Workspace** is the AI Engineer's native web UI.
- The **Orchestrator** coordinates execution of a **Task**.
- A **Task** has exactly one **Worktree**.
- A **Worktree** is created immediately when a **Task** is created.
- A **Task** should have a dedicated **Sandbox** while it is active.
- A **Cloud Sandbox** should have exactly one active **Cloud Worktree** for its **Task**.
- A **Cloud Worktree** should have Task-scoped **Sandbox Services** rather than sharing mutable runtime services with other active **Tasks**.
- A Task-scoped Convex deployment is a **Sandbox Service** when a **Task** needs to debug or validate Convex behavior.
- Browser access is a deferred **Sandbox Service** for **Cloud Sandboxes**.
- A **Worktree Title** should be derived from the Task title or originating Team App object.
- A **Worktree Branch** should be created from the **Project**'s default branch unless an **Operator** explicitly chooses another base.
- **Team App**-created **Tasks** should not choose non-default base branches from metadata in v1.
- The expected branch freshness operation is updating the **Worktree** with the latest changes from the **Project**'s default branch.
- A human triggers branch freshness by messaging the **Primary Thread**.
- Humans identify a **Task** by its **Worktree**, **Worktree Title**, and **External Links** rather than a separate Task identifier.
- The **Workspace** should use Task-first language for human-facing workflows and labels.
- A **Worktree** belongs to exactly one **Project**.
- A **Task** belongs to exactly one **Project** through its **Worktree**.
- A **Project** groups **Worktrees** for Tasks against the same repository or codebase root.
- A **Worktree** contains many **Threads**.
- **Threads** are where code is built for a **Task**.
- A **Thread** inside a **Worktree** is part of that **Worktree**'s **Task**.
- A **Task** can have many **Work Sessions** over time.
- A **Work Session** belongs to one **Task** and one **Thread**.
- A **Work Session** ends when the **Coding Agent** completes, fails, is interrupted, or is superseded by a restart.
- **Work Session** is an internal operational concept, not a primary human-facing UI label.
- The **Orchestrator** should model **Work Sessions** as their own operational records.
- Important **Work Session** milestones should also appear as Task event records when they matter to the Task narrative.
- The **Orchestrator** should model **Threads** for a **Task** as separate Task-thread associations rather than embedding them directly in the Task record.
- A **Task** should point to its current **Primary Thread** association.
- A **Task** has exactly one **Primary Thread**.
- The **Primary Thread** is pinned directly below its **Worktree** in the sidebar.
- If the **Primary Thread** is replaced, the old one becomes a historical **Thread** and the replacement is pinned.
- The **Workspace** sidebar is organized as **Project** -> **Task** -> **Threads**.
- A **Task** row in the **Workspace** sidebar is backed by its **Worktree**.
- A **Task** row in the **Workspace** sidebar shows its **Task Status**.
- A **Task** row in the **Workspace** sidebar shows **External Link** icons for its Linear issue, Slack thread, and GitHub Pull Request when present.
- A **Worktree Branch** should be visible from a Task details panel or tooltip, not as primary sidebar text.
- The **Orchestrator** uses the **Primary Thread** as the human-facing interface for a **Task**.
- The **Orchestrator** infers common **Task** intents from natural-language messages.
- The **Orchestrator** should make inferred **Task** actions visible in the **Primary Thread** and linked **Team Apps**.
- The **Primary Thread** is the canonical narrative for important **Task** messages, status changes, and handoffs.
- Important **Team App** messages and status changes should be mirrored or summarized in the **Primary Thread**.
- Only selected updates from the **Primary Thread** should be posted back to **Team Apps**.
- In v1, the **Orchestrator** can respond to mentions and messages in linked **Team App** threads.
- A linked **Team App** thread can become a **Muted Team App Thread** when a human asks the AI Engineer to mute.
- In a **Muted Team App Thread**, the **Orchestrator** posts no routine updates and responds only to mentions or an unmute request.
- Muting one linked **Team App** thread does not mute other **External Links** for the same **Task**.
- A human can prefix a message with `- aside` to make it an **Aside Message**.
- The **Orchestrator** ignores **Aside Messages** completely: no response, status change, or **Primary Thread** mirror.
- **Aside Messages** apply in **Team Apps**, not in the **Primary Thread**.
- The **Primary Thread** can perform coding work directly.
- Supporting **Threads** are optional, human-created Threads used when a **Task** needs decomposition.
- A supporting **Thread** can use a different **Coding Agent** from the **Primary Thread**.
- A **Task** can be created from the web UI or from a **Team App** such as Linear or Slack.
- A **Task** can be created from an **Intake Source**.
- An email to `help@nextcard.com` is an **Intake Source** for the Nextcard **Organization**.
- The v1 product priorities are **Workspace** Tasks, Linear issue assignment and status sync, GitHub Pull Request creation and linking, and Slack Conversations promoted into **Tasks**.
- The next product direction adds email intake, **Cloud Sandboxes**, **Cloud Worktrees**, Task-scoped Convex **Sandbox Services**, and deferred browser access.
- When an **Intake Source** reports a bug for Nextcard, the **Orchestrator** should create or link a Linear issue, create a **Task**, allocate a **Cloud Sandbox**, create a **Cloud Worktree**, provision required **Sandbox Services**, and start the **Primary Thread**.
- In v1, GitHub is represented through **Pull Requests**, not GitHub issues, discussions, or Actions workflows.
- In v1, a Linear issue creates a **Task** when it is assigned to the AI Engineer's Linear agent.
- A Linear-created **Task** should create its **Worktree** and **Primary Thread**, post an acknowledgement with useful links, then start the **Coding Agent**.
- A Linear acknowledgement should always link the **Workspace** Task and include a **Draft Pull Request** link only when one already exists or code changes are clearly expected.
- A **Conversation** can happen in the **Workspace** or in a **Team App**.
- A **Conversation** can be promoted into a **Task** when the **Orchestrator** identifies **Repo-Grounded Work**.
- Explicit **Tasks** created in Linear or the **Workspace** should start automatically.
- In v1, the **Workspace** should prioritize creating a new **Task** in a **Project**.
- A **Workspace** New Task requires a **Project** and an initial human request.
- The **Orchestrator** derives the **Worktree Title** for a **Workspace** New Task and asks follow-up questions when the request is not actionable.
- A vague **Workspace** New Task still creates its **Worktree** and **Primary Thread**, but becomes Needs Input before coding.
- **Conversation**-originated work should become a **Task** only after the **Orchestrator** identifies **Repo-Grounded Work** and resolves the **Project**.
- A Slack **Conversation** can become a **Task** when the **Orchestrator** determines coding intent is clear.
- When a Slack **Conversation** becomes a **Task**, the **Orchestrator** posts the **Workspace** Task link back to Slack.
- A Slack-created **Task** starts automatically after promotion.
- The **Orchestrator** can proceed with normal repo work inside the **Sandbox** without asking first.
- The **Orchestrator** can post routine **Task** updates and **Pull Request** links to **Team Apps**.
- The **Orchestrator** posts **Team App** updates on meaningful events, not on a periodic heartbeat.
- Merge, production deploy, and final Done require **Operator** authority.
- Production deployment is outside the initial **AI Engineer** boundary.
- In v1, the **Orchestrator** does not autonomously create supporting **Threads**, switch **Coding Agents**, deploy to production, or post periodic heartbeat updates.
- The **Orchestrator** resolves which **Project** a **Task** belongs to.
- The **Orchestrator** asks a human when **Project** resolution is ambiguous.
- For Slack-created work, the Slack org resolves the **Organization**, then the **Orchestrator** resolves the **Project**.
- For Linear-created work, the Linear workspace resolves the **Organization**, then Linear routing helps the **Orchestrator** resolve the **Project**.
- A GitHub repository belongs to one **Project**.
- A **Task Status** is one of Ready, Working, Needs Input, Ready for Review, Done, Blocked, Failed, or Canceled.
- A Linear issue status can be mapped to a **Task Status**, but does not define the Task lifecycle.
- When a **Task** has a Linear issue **External Link**, the **Orchestrator** should sync routine **Task Status** changes back to Linear.
- The **Orchestrator** owns product **Task Status**, while Team App statuses can drive transitions when they are explicit human workflow signals.
- A **Task** is Needs Input when a specific human answer can unblock it.
- A **Task** is Blocked when it cannot proceed without external action, access, or system repair.
- A **Task** is Failed when execution ends because of an unrecoverable runtime or system error.
- A Failed **Task** can restart within the same **Task** and **Worktree**.
- Restarting a Failed **Task** should reuse the **Primary Thread** when possible, or create a replacement **Primary Thread** when necessary.
- Restarting a Failed **Task** creates a new **Work Session**, not a new **Task**.
- A **Task** in Needs Input can continue safe, non-conflicting work while waiting for the human answer.
- A **Task** becomes Ready for Review when its Linear issue moves to an in-review status or when a human message indicates the work is ready for merge or pull request review.
- A **Worktree** can have zero or one Linear issue **External Link**.
- A **Worktree** can have zero or one Slack thread **External Link**.
- A **Worktree** can have zero or more GitHub pull request **External Links**.
- The **Orchestrator** should model **External Links** as lean Task-linked records, not embedded arrays on **Tasks**.
- **External Link** records should store stable platform references, URLs, mute state, and sync cursors only when needed.
- A **Draft Pull Request** should be created early once a **Task** is expected to change code.
- Pure investigation **Tasks** do not need a **Pull Request** until the **Orchestrator** determines code changes are likely.
- When a **Task** becomes Ready for Review, its **Draft Pull Request** should be moved out of draft.
- When a **Task** is Ready for Review, the **Orchestrator** should send the **Pull Request** link back through the relevant **Team Apps**.
- A coding **Task** is Done only after an **Operator** reviews the work and merges the **Pull Request**.
- A no-code **Task** is Done when an **Operator** accepts the documented outcome in the **Workspace** or a **Conversation**.
- Any human participant can cancel a **Task**.
- Canceling a **Task** archives its **Worktree**, closes any open **Draft Pull Request**, and posts a cancellation summary to linked **Team Apps**.
- If a canceled **Task** has a non-draft or reviewed **Pull Request**, the **Orchestrator** asks before closing it.
- A **Worktree** becomes an **Archived Worktree** after its **Task** is Done.
- Deleting a local git worktree is separate from archiving the **Worktree** in the **Workspace**.
- An **Operator** supervises the **AI Engineer**.
- A **Teammate** can delegate or discuss a **Task**.

## Example Dialogue

> **Dev:** "Is T3 Code the AI Engineer, or is it just the app we forked?"
> **Domain expert:** "The whole repo is becoming the AI Engineer. T3 Code is the open-source coding system inside it, and the Orchestrator is the brain."
>
> **Dev:** "Should we call a Linear issue, provider thread, and execution run the same thing?"
> **Domain expert:** "No. The product-level thing is a Task. Issues, threads, and runs are ways a Task enters the system or gets executed."
>
> **Dev:** "Is everyone just a user?"
> **Domain expert:** "No. A CTO supervising execution is an Operator, while a non-technical growth collaborator is a Teammate."
>
> **Dev:** "Should a Slack thread immediately become a Task?"
> **Domain expert:** "No. A Slack thread can start as conversation; it becomes a Task only when the AI Engineer determines there is coding work to do."
>
> **Dev:** "What is a Slack chat before it becomes coding work?"
> **Domain expert:** "It is a Conversation. A Conversation becomes a Task only if the Orchestrator identifies actionable coding work."
>
> **Dev:** "Does a human need to say 'make a task' in Slack?"
> **Domain expert:** "No. The Orchestrator can create the Task when coding intent is clear, but asks when intent or Project is ambiguous."
>
> **Dev:** "Does a Slack-created Task wait after promotion?"
> **Domain expert:** "No. Once promoted from Conversation to Task, it starts automatically."
>
> **Dev:** "Can the Workspace have pre-Task chat too?"
> **Domain expert:** "Yes. Conversations can happen in the Workspace or in Team Apps; Linear assignment usually creates a Task directly."
>
> **Dev:** "Should Workspace v1 center general chat or New Task?"
> **Domain expert:** "New Task. Workspace Conversations can exist later, but v1 should prioritize creating a Task in a Project."
>
> **Dev:** "What does Workspace New Task require?"
> **Domain expert:** "A Project and an initial human request; the Orchestrator can derive the title and ask follow-up questions when needed."
>
> **Dev:** "Does a vague Workspace Task start coding immediately?"
> **Domain expert:** "No. It creates the Task container, then the Primary Thread asks clarifying questions and the Task becomes Needs Input."
>
> **Dev:** "Should explicit Linear or Workspace Tasks wait for Operator approval before starting?"
> **Domain expert:** "No. Explicit Tasks should start automatically; the Orchestrator asks only when the Task is ambiguous or risky."
>
> **Dev:** "Should the Orchestrator ask before normal repo work?"
> **Domain expert:** "No. The AI Engineer works in a Sandbox, so normal repo work can proceed without asking first."
>
> **Dev:** "What still needs Operator authority?"
> **Domain expert:** "Merge, production deploy, and final Done require Operator authority; routine Task updates and PR links can be posted automatically."
>
> **Dev:** "Does the initial AI Engineer deploy to production?"
> **Domain expert:** "No. The initial boundary is preparing and handing off reviewed code, not production deployment."
>
> **Dev:** "What is outside the Orchestrator's v1 boundary?"
> **Domain expert:** "Autonomous supporting Thread creation, Coding Agent switching, production deployment, and periodic heartbeat updates."
>
> **Dev:** "Does every product question become a Task?"
> **Domain expert:** "No. A Conversation becomes a Task when the next useful step is Repo-Grounded Work."
>
> **Dev:** "Who decides which Project a Slack-created Task belongs to?"
> **Domain expert:** "The Orchestrator resolves the Project before creating the Task's Worktree."
>
> **Dev:** "Should the Orchestrator guess between two possible Projects?"
> **Domain expert:** "No. It should ask a human when Project resolution is ambiguous."
>
> **Dev:** "Do Linear issue statuses define our Task lifecycle?"
> **Domain expert:** "No. The AI Engineer has its own Task Status values, and Linear statuses map onto them."
>
> **Dev:** "What if Linear status and Orchestrator status disagree?"
> **Domain expert:** "The Orchestrator owns product Task Status, but explicit human workflow signals from Team Apps can drive transitions."
>
> **Dev:** "Should the Orchestrator update Linear statuses too?"
> **Domain expert:** "Yes. Routine Task Status changes should sync back to Linear when the Task is linked to a Linear issue."
>
> **Dev:** "Should Team Apps get periodic progress heartbeats?"
> **Domain expert:** "No. Keep v1 simple: post updates on meaningful events only."
>
> **Dev:** "What's the difference between Needs Input and Blocked?"
> **Domain expert:** "Needs Input means a specific human answer can unblock the Task; Blocked means external action, access, or system repair is required."
>
> **Dev:** "Is a provider crash just Blocked?"
> **Domain expert:** "No. Failed means execution ended because of an unrecoverable runtime or system error."
>
> **Dev:** "Does retrying a Failed Task create a new Task?"
> **Domain expert:** "No. Restart within the same Task and Worktree, reusing the Primary Thread when possible."
>
> **Dev:** "What is a restart operationally?"
> **Domain expert:** "A new Work Session under the same Task, usually in the Primary Thread."
>
> **Dev:** "What happens if the Primary Thread has to be replaced?"
> **Domain expert:** "The replacement becomes the pinned Primary Thread, and the old one remains as a historical Thread under the same Worktree."
>
> **Dev:** "Does Needs Input pause all work?"
> **Domain expert:** "No. The Orchestrator can continue safe, non-conflicting work while waiting for the answer."
>
> **Dev:** "When should the AI Engineer mark a Task Ready for Review?"
> **Domain expert:** "When Linear is in review, or when a human says the work is ready for merge or PR review; the Orchestrator should respond with the Pull Request link."
>
> **Dev:** "Should every Task create a PR immediately?"
> **Domain expert:** "No. Create a Draft Pull Request early once code changes are expected, and move it out of draft when the Task becomes Ready for Review."
>
> **Dev:** "Is a Task Done when the AI Engineer opens a PR?"
> **Domain expert:** "No. A coding Task is Done only after an Operator reviews the work and merges the Pull Request."
>
> **Dev:** "How does an investigation Task finish if no PR is needed?"
> **Domain expert:** "An Operator can mark a no-code Task Done by accepting its documented outcome in the Workspace or a Conversation."
>
> **Dev:** "Who can cancel a Task?"
> **Domain expert:** "Any human participant can cancel a Task."
>
> **Dev:** "What happens if a canceled Task already has a PR?"
> **Domain expert:** "The Orchestrator closes open Draft Pull Requests automatically, but asks before closing non-draft or reviewed Pull Requests."
>
> **Dev:** "Should we delete the Worktree when the Task is Done?"
> **Domain expert:** "No. The Worktree becomes archived in the Workspace; deleting the local git worktree is a separate cleanup operation."
>
> **Dev:** "Should the sidebar show a flat list of threads?"
> **Domain expert:** "No. The sidebar should be organized by Project, then Task, then Threads, with each Task backed by its Worktree."
>
> **Dev:** "What should the Task row show?"
> **Domain expert:** "The Task row should show Task Status and link icons for related Team Apps and Pull Requests."
>
> **Dev:** "Should Worktree names be optimized for humans or git?"
> **Domain expert:** "The Worktree Title should be human-readable; branch and filesystem names can be slugified separately with a stable Task identifier."
>
> **Dev:** "Do humans need a separate Task ID?"
> **Domain expert:** "No. Humans identify a Task through its Worktree, title, and links; internal IDs are implementation details."
>
> **Dev:** "Should the UI say Task or Worktree?"
> **Domain expert:** "Task. Worktree is the underlying coding workspace, but the human-facing UI should use Task-first language."
>
> **Dev:** "Where should humans see the branch?"
> **Domain expert:** "The Worktree Branch should be visible in Task details or a tooltip, not as primary sidebar text."
>
> **Dev:** "What branch should new Tasks start from?"
> **Domain expert:** "Create the Worktree Branch from the Project's default branch unless an Operator explicitly chooses another base."
>
> **Dev:** "Should Linear metadata choose a non-default base branch?"
> **Domain expert:** "No. Team App-created Tasks use the Project default branch in v1."
>
> **Dev:** "What branch freshness behavior matters for v1?"
> **Domain expert:** "Only updating the Worktree with the latest changes from the Project's default branch."
>
> **Dev:** "How does a human ask for the latest default branch changes?"
> **Domain expert:** "Message the Primary Thread to update the Worktree from the Project's default branch."
>
> **Dev:** "Does a Thread own the code changes?"
> **Domain expert:** "No. The Worktree tracks the code changes for the Task; Threads are where the coding conversations and execution happen."
>
> **Dev:** "Which Thread should Linear or Slack treat as the Task's answer?"
> **Domain expert:** "The Primary Thread is where the Orchestrator relays human messages, status, what was done, and final handoff; other Threads support the same Task."
>
> **Dev:** "Do humans need formal commands to operate a Task?"
> **Domain expert:** "No. The Orchestrator should infer common Task intents from natural-language messages and make the resulting action visible."
>
> **Dev:** "Should Team App activity be visible from the Workspace?"
> **Domain expert:** "Yes. Important Team App messages and status changes should be mirrored or summarized in the Primary Thread."
>
> **Dev:** "Should every Primary Thread message go back to Slack or Linear?"
> **Domain expert:** "No. Team Apps should receive selected updates, not raw Primary Thread chatter."
>
> **Dev:** "Should the Orchestrator respond only when mentioned?"
> **Domain expert:** "No. In v1, it can respond to mentions and messages in linked Team App threads, with a mute option."
>
> **Dev:** "What does mute do?"
> **Domain expert:** "A human can ask the AI Engineer to mute a linked Team App thread; after that, the Orchestrator responds only to mentions or an unmute request."
>
> **Dev:** "Does muting Slack mute Linear for the same Task?"
> **Domain expert:** "No. Mute applies per linked Team App thread, not to the whole Task."
>
> **Dev:** "How can humans talk around the AI Engineer in a linked thread?"
> **Domain expert:** "Prefix the message with `- aside`; the Orchestrator should ignore Aside Messages."
>
> **Dev:** "Should Aside Messages still be mirrored as context?"
> **Domain expert:** "No. Aside Messages are ignored completely."
>
> **Dev:** "Can humans use `- aside` in the Primary Thread?"
> **Domain expert:** "No. Aside Messages are a Team App convention; Primary Thread messages are addressed to the AI Engineer."
>
> **Dev:** "Does implementation always need a supporting Thread?"
> **Domain expert:** "No. Small and medium Tasks can be handled directly in the Primary Thread."
>
> **Dev:** "Should the Orchestrator create supporting Threads automatically?"
> **Domain expert:** "No. Supporting Threads are human-created for now."
>
> **Dev:** "Should we call Slack and Linear tools?"
> **Domain expert:** "No. Agent tools are different. Slack, Linear, GitHub, Google Drive, Fathom, and Zoom are Team Apps; the web UI is the Workspace."
>
> **Dev:** "Which Team Apps are v1?"
> **Domain expert:** "Workspace Tasks, Linear, GitHub Pull Requests, and Slack. Google Drive, Fathom, and Zoom are examples of future Team Apps, not v1 scope."
>
> **Dev:** "Is all of GitHub a v1 Team App?"
> **Domain expert:** "No. In v1, GitHub appears through Pull Requests only."
>
> **Dev:** "What Linear event creates a Task in v1?"
> **Domain expert:** "A Linear issue creates a Task when it is assigned to the AI Engineer's Linear agent."
>
> **Dev:** "What happens after Linear assigns an issue to the AI Engineer?"
> **Domain expert:** "Create the Task, Worktree, and Primary Thread; acknowledge with useful links; then start the Coding Agent."
>
> **Dev:** "Should the first Linear reply always include a PR?"
> **Domain expert:** "No. It should always link the Workspace Task and include a Draft Pull Request only when one already exists or code changes are clearly expected."
>
> **Dev:** "Should we tell Teammates that a provider session failed?"
> **Domain expert:** "No. Codex, Claude Code, and OpenCode are Coding Agents in product language; provider is runtime configuration language."
>
> **Dev:** "Who owns Task state?"
> **Domain expert:** "The Orchestrator owns Task identity, status, Team App links, mute state, and the current Primary Thread pointer; T3 Code owns local Project, Worktree, Thread, and Coding Agent runtime state."
>
> **Dev:** "Should apps/orchestrator keep controlThread and executionRun as core concepts?"
> **Domain expert:** "No. Those were Linear-MVP bridge terms; refactor apps/orchestrator around Task domain terms."
>
> **Dev:** "Can T3 Code create Tasks directly?"
> **Domain expert:** "No. Product Tasks are created through the Orchestrator and represented in T3 Code by the local Project, Worktree, and Threads created for that Task."
>
> **Dev:** "What happens to old local T3 Threads?"
> **Domain expert:** "Nothing special in v1. The AI Engineer builds on the T3 backend for new Orchestrator-created Tasks; it does not import arbitrary existing T3 Threads."
>
> **Dev:** "Where should the Workspace read the sidebar Task tree from?"
> **Domain expert:** "From the Orchestrator. T3 Code remains the runtime endpoint for live Thread interaction and sandbox operations."
>
> **Dev:** "Should the Workspace be a separate app?"
> **Domain expert:** "No. Implement it inside apps/web as a new Task tree component that replaces the original flat T3 Code sidebar."
>
> **Dev:** "Should Convex store full T3 Thread transcripts?"
> **Domain expert:** "No. The Orchestrator stores Task-level narrative events and T3 Thread references; T3 Code owns full Thread transcripts and Coding Agent output."
>
> **Dev:** "Should Convex duplicate every display field?"
> **Domain expert:** "No. Store stable references and orchestration-owned fields, and derive display fields from source systems when possible."
>
> **Dev:** "Who owns PR creation?"
> **Domain expert:** "The Orchestrator decides when a Pull Request should exist; T3 Code performs the git/GitHub work and reports the PR reference back."
>
> **Dev:** "Can Convex rely only on T3's local Project table?"
> **Domain expert:** "No. The Orchestrator owns a Project registry for Task routing, while T3 owns its local Project runtime state."
>
> **Dev:** "Should Projects be auto-discovered?"
> **Domain expert:** "No. Operators configure Projects in the Workspace, and the Orchestrator can validate or sync them with T3 Code."
>
> **Dev:** "What is in v1 Project configuration?"
> **Domain expert:** "Repo name, sandbox workspace root, default branch, GitHub repo, and Linear routing when used; no Slack channel mapping."
>
> **Dev:** "Does a Slack org identify the Project?"
> **Domain expert:** "No. A Slack org identifies the Organization; the Orchestrator still resolves the Project inside that Organization."
>
> **Dev:** "Does Linear use the same Organization boundary?"
> **Domain expert:** "Yes. A Linear workspace resolves the Organization, then Linear routing helps resolve the Project."
>
> **Dev:** "Where does GitHub fit?"
> **Domain expert:** "A GitHub organization or account maps to an Organization, and each GitHub repository belongs to one Project."
>
> **Dev:** "Are we committing to multi-organization SaaS now?"
> **Domain expert:** "No. This repo targets one internal Organization for now."
>
> **Dev:** "Does Organization mean every table needs organizationId now?"
> **Domain expert:** "No. Organization names the internal account boundary for Team App installs, but v1 does not need to overbuild tenancy."
>
> **Dev:** "Should the Orchestrator switch Coding Agents per Thread?"
> **Domain expert:** "No. The Orchestrator uses the organization-wide Default Coding Agent."
>
> **Dev:** "Can a human override a Thread's Coding Agent?"
> **Domain expert:** "No. A Thread keeps the Coding Agent it was created with; use a new Thread for another Coding Agent."
>
> **Dev:** "If an Operator creates a Claude Thread in a Codex Task's Worktree, is it a new Task?"
> **Domain expert:** "No. Any Thread inside the Worktree belongs to that Worktree's Task."
>
> **Dev:** "Is Project a product area or a repo?"
> **Domain expert:** "A Project is a repo or codebase root, like the T3 Code project."
>
> **Dev:** "Do investigation-only Tasks still need a Worktree?"
> **Domain expert:** "Yes. The Worktree is created immediately as the Task's isolated workspace, even if no code change is ultimately made."

## Flagged Ambiguities

- "T3 Code" was used both for the forked codebase and the intended startup product; resolved: **AI Engineer** is the product, while **T3 Code** is the underlying open-source coding system.
- "task", "issue", "run", and "thread" were all candidates for the main unit of work; resolved: **Task** is the product-level unit, while issues, runs, and threads are platform or execution concepts.
- "user" was too broad for the humans around the system; resolved: **Operator** supervises execution, while **Teammate** collaborates without necessarily owning execution details.
- "thread" can mean a T3 Code thread, a Slack thread, or a provider runtime thread; resolved: **Thread** means a T3 Code thread inside a Worktree unless explicitly qualified as a Slack thread or provider thread.
- A Task was initially described as one-to-one with a Worktree, Linear issue, or Slack thread; resolved: a **Task** always has exactly one **Worktree**, while Linear issues and Slack threads are optional **External Links** on the Worktree.
- "workspace" can mean a UI, repo root, provider state directory, or git working area; resolved: **Workspace** means the AI Engineer's native web UI, while **Worktree** means the isolated coding workspace for a Task.
- "conversation" and "thread" can both mean chat-like exchanges; resolved: **Conversation** is pre-Task, while **Thread** is a T3 Code execution conversation inside a Worktree.
- "provider" is implementation language for runtime configuration; resolved: **Coding Agent** is the product-domain term for Codex, Claude Code, OpenCode, and similar systems.
- "Coding Agent" selection could be organization-wide, per-Project, per-Operator, or per-Thread; resolved: the **Default Coding Agent** is organization-wide for now.
- Current Linear MVP docs mention comment or mention webhooks as triggers; resolved target model: v1 Linear Task creation is assignment to the AI Engineer's Linear agent.
