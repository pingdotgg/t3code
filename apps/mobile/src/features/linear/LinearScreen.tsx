import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, LinearMutationInput, LinearWorkspace } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { useState, type ReactNode } from "react";
import { View, Pressable, Linking } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useEnvironments } from "../../state/environments";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ id: string; name: string }>;
  onChange: (id: string) => void;
}) {
  return (
    <Menu
      actions={[
        { id: "", title: "None / all" },
        ...options.map((o) => ({
          id: o.id,
          title: o.name,
          state: o.id === value ? ("on" as const) : ("off" as const),
        })),
      ]}
      onPressAction={(event) => onChange(event.nativeEvent.event)}
    >
      <View className="min-h-12 justify-center rounded-lg bg-secondary px-3">
        <Text className="text-xs text-foreground-muted">{label}</Text>
        <Text className="text-foreground">
          {options.find((o) => o.id === value)?.name ?? "None / all"}
        </Text>
      </View>
    </Menu>
  );
}
function Markdown({ text }: { text: string | null }) {
  const { nativeTextStyle } = useMarkdownPreviewStyles();
  return (
    <SelectableMarkdownText
      markdown={text ?? ""}
      textStyle={nativeTextStyle}
      onLinkPress={(url) => {
        if (/^https?:\/\//i.test(url)) void Linking.openURL(url);
      }}
    />
  );
}
function Field({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  multiline?: boolean;
}) {
  return (
    <View className="gap-1">
      <Text className="text-xs text-foreground-muted">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        className={`rounded-lg border border-divider bg-screen px-3 py-3 text-foreground ${multiline ? "min-h-32" : ""}`}
      />
    </View>
  );
}
function Notice({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="alert" className="p-4 text-foreground-muted">
      {children}
    </Text>
  );
}
export function LinearScreen() {
  const { environments } = useEnvironments();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environmentId =
    selected ??
    environments.find((env) => env.connection.phase === "connected")?.environmentId ??
    environments[0]?.environmentId;
  const config = environments.find((env) => env.environmentId === environmentId)?.serverConfig;
  return (
    <SettingsScreen title="Linear" workspaceRoot>
      <ScreenScrollView
        contentContainerStyle={{ padding: 16, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        <Choice
          label="Environment"
          value={environmentId ?? ""}
          options={environments.map((env) => ({ id: env.environmentId, name: env.label }))}
          onChange={(id) =>
            setSelected(environments.find((env) => env.environmentId === id)?.environmentId ?? null)
          }
        />
        {environmentId && config?.environment.capabilities.linear ? (
          <Workspace key={environmentId} environmentId={environmentId} />
        ) : (
          <Notice>
            {environmentId && config
              ? "Update this environment’s T3 server to use Linear."
              : "Connect an environment to use Linear."}
          </Notice>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
type Mutate = (input: LinearMutationInput) => Promise<boolean>;
function Workspace({ environmentId }: { environmentId: EnvironmentId }) {
  const connection = useEnvironmentQuery(
    linearEnvironment.connection({ environmentId, input: {} }),
  );
  const workspace = useEnvironmentQuery(
    connection.data?.connected ? linearEnvironment.workspace({ environmentId, input: {} }) : null,
  );
  const [view, setView] = useState("mine");
  const [team, setTeam] = useState("");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [issue, setIssue] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [cursors, setCursors] = useState<Array<string>>([]);
  const after = cursors.at(-1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canWrite = useAtomValue(linearEnvironment.mutate.permissionAtom(environmentId));
  const run = useAtomCommand(linearEnvironment.mutate, { reportFailure: false });
  const mutate: Mutate = async (input) => {
    setBusy(true);
    setError(null);
    const result = await run({ environmentId, input });
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const failure = Cause.squash(result.cause);
      setError(failure instanceof Error ? failure.message : "Linear could not save the change.");
      return false;
    }
    return true;
  };
  const issues = useEnvironmentQuery(
    workspace.data && view !== "inbox"
      ? linearEnvironment.issues({
          environmentId,
          input: {
            view: view === "mine" ? "mine" : view === "triage" ? "triage" : "all",
            ...(team ? { teamId: team } : {}),
            ...(submitted ? { query: submitted } : {}),
            ...(after ? { after } : {}),
          },
        })
      : null,
  );
  const inbox = useEnvironmentQuery(
    workspace.data && view === "inbox"
      ? linearEnvironment.inbox({ environmentId, input: after ? { after } : {} })
      : null,
  );
  const page = view === "inbox" ? inbox.data?.pageInfo : issues.data?.pageInfo;
  return (
    <>
      {connection.data?.connected === false && (
        <Notice>
          Connect your Linear API key in this environment’s Linear connection settings on the web or
          desktop app. The same connection is used here.
        </Notice>
      )}
      {(connection.error || workspace.error || error) && (
        <Notice>
          {connection.error ?? workspace.error ?? error}
          <Button
            label="Retry"
            onPress={() => {
              connection.refresh();
              workspace.refresh();
              issues.refresh();
              inbox.refresh();
            }}
          />
        </Notice>
      )}
      {workspace.data ? (
        <>
          <Text className="text-xl font-t3-bold text-foreground">
            {workspace.data.organization.name}
          </Text>
          {issue || creating ? (
            <Issue
              key={issue ?? "new"}
              environmentId={environmentId}
              id={issue}
              teamId={team}
              workspace={workspace.data}
              canWrite={canWrite && !busy}
              mutate={mutate}
              close={() => {
                setIssue(null);
                setCreating(false);
              }}
            />
          ) : (
            <>
              <Choice
                label="View"
                value={view}
                options={[
                  { id: "mine", name: "My issues" },
                  { id: "all", name: "All issues" },
                  { id: "triage", name: "Triage" },
                  { id: "inbox", name: "Inbox" },
                ]}
                onChange={(id) => {
                  setView(id || "mine");
                  setCursors([]);
                }}
              />
              <Choice
                label="Team"
                value={team}
                options={workspace.data.teams}
                onChange={(id) => {
                  setTeam(id);
                  setCursors([]);
                }}
              />
              {view !== "inbox" && (
                <>
                  <Field label="Search issues" value={query} onChange={setQuery} />
                  <View className="flex-row flex-wrap gap-2">
                    <Button
                      label="Search"
                      onPress={() => {
                        setSubmitted(query);
                        setCursors([]);
                      }}
                    />
                    <Button
                      label="New issue"
                      disabled={!canWrite || busy}
                      onPress={() => setCreating(true)}
                    />
                  </View>
                </>
              )}
              {(issues.error || inbox.error) && <Notice>{issues.error ?? inbox.error}</Notice>}
              {view === "inbox"
                ? inbox.data?.nodes.map((item) => (
                    <View key={item.id} className="gap-2 rounded-lg border border-divider p-4">
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => {
                          if (item.issue) setIssue(item.issue.id);
                        }}
                      >
                        <Text className="text-base text-foreground">
                          {item.readAt ? "" : "● "}
                          {item.title}
                        </Text>
                        <Text className="text-foreground-muted">{item.subtitle}</Text>
                      </Pressable>
                      <View className="flex-row flex-wrap gap-2">
                        <Button
                          label={item.readAt ? "Mark unread" : "Mark read"}
                          disabled={!canWrite || busy}
                          onPress={() =>
                            void mutate({
                              kind: "notificationUpdate",
                              id: item.id,
                              input: { readAt: item.readAt ? null : new Date().toISOString() },
                            })
                          }
                        />
                        <Button
                          label="Archive"
                          disabled={!canWrite || busy}
                          onPress={() => void mutate({ kind: "notificationArchive", id: item.id })}
                        />
                      </View>
                    </View>
                  ))
                : issues.data?.nodes.map((item) => (
                    <Pressable
                      key={item.id}
                      accessibilityRole="button"
                      onPress={() => setIssue(item.id)}
                      className="gap-1 rounded-lg border border-divider p-4"
                    >
                      <Text className="text-xs text-foreground-muted">
                        {item.identifier} · {item.state.name}
                      </Text>
                      <Text className="text-base text-foreground">{item.title}</Text>
                      <Text className="text-xs text-foreground-muted">
                        {item.assignee?.name ?? "Unassigned"} · {item.priorityLabel}
                      </Text>
                    </Pressable>
                  ))}
              {(view === "inbox" ? inbox.data?.nodes.length : issues.data?.nodes.length) === 0 && (
                <Notice>
                  {page?.hasNextPage
                    ? "No matches on this page. Continue to the next page."
                    : "No items in this view."}
                </Notice>
              )}
              <View className="flex-row gap-2">
                <Button
                  label="Previous"
                  disabled={!after || issues.isPending || inbox.isPending}
                  onPress={() => setCursors((values) => values.slice(0, -1))}
                />
                <Button
                  label="Next page"
                  disabled={!page?.hasNextPage || issues.isPending || inbox.isPending}
                  onPress={() => {
                    if (page?.endCursor) setCursors((values) => [...values, page.endCursor!]);
                  }}
                />
                <Button
                  label="Refresh"
                  onPress={() => {
                    issues.refresh();
                    inbox.refresh();
                  }}
                />
              </View>
            </>
          )}
        </>
      ) : connection.isPending || workspace.isPending ? (
        <Notice>Loading Linear…</Notice>
      ) : null}
    </>
  );
}
function Issue({
  environmentId,
  id,
  teamId,
  workspace,
  canWrite,
  mutate,
  close,
}: {
  environmentId: EnvironmentId;
  id: string | null;
  teamId: string;
  workspace: typeof LinearWorkspace.Type;
  canWrite: boolean;
  mutate: Mutate;
  close: () => void;
}) {
  const detail = useEnvironmentQuery(
    id ? linearEnvironment.issue({ environmentId, input: { id } }) : null,
  );
  const issue = detail.data;
  const [editing, setEditing] = useState(!id);
  const [team, setTeam] = useState(teamId || workspace.teams[0]?.id || "");
  const context = useEnvironmentQuery(
    linearEnvironment.teamContext({ environmentId, input: { id: issue?.team.id ?? team } }),
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [state, setState] = useState("");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState("0");
  const [comment, setComment] = useState("");
  const [cursors, setCursors] = useState<Array<string>>([]);
  const after = cursors.at(-1);
  const comments = useEnvironmentQuery(
    id
      ? linearEnvironment.comments({ environmentId, input: { id, ...(after ? { after } : {}) } })
      : null,
  );
  return (
    <>
      <Button label="Back to list" tone="text" onPress={close} />
      {detail.error && <Notice>{detail.error}</Notice>}
      {editing ? (
        <>
          {!id && (
            <Choice
              label="Team"
              value={team}
              options={workspace.teams}
              onChange={(value) => {
                setTeam(value);
                setState("");
              }}
            />
          )}
          <Field label="Issue title" value={title} onChange={setTitle} />
          <Field
            label="Description (Markdown)"
            value={description}
            onChange={setDescription}
            multiline
          />
          <Choice
            label="Status"
            value={state}
            options={context.data?.states ?? []}
            onChange={setState}
          />
          <Choice
            label="Assignee"
            value={assignee}
            options={workspace.users}
            onChange={setAssignee}
          />
          <Choice
            label="Priority"
            value={priority}
            options={["None", "Urgent", "High", "Medium", "Low"].map((name, i) => ({
              id: String(i),
              name,
            }))}
            onChange={setPriority}
          />
          <View className="flex-row gap-2">
            <Button label="Cancel" onPress={() => (id ? setEditing(false) : close())} />
            <Button
              label="Save issue"
              disabled={!canWrite || !title.trim() || !team}
              onPress={() =>
                void mutate(
                  id
                    ? {
                        kind: "issueUpdate",
                        id,
                        input: {
                          title,
                          description,
                          stateId: state || undefined,
                          assigneeId: assignee || null,
                          priority: Number(priority),
                        },
                      }
                    : {
                        kind: "issueCreate",
                        input: {
                          teamId: team,
                          title,
                          description,
                          ...(state ? { stateId: state } : {}),
                          assigneeId: assignee || null,
                          priority: Number(priority),
                        },
                      },
                ).then((ok) => {
                  if (ok) {
                    if (id) setEditing(false);
                    else close();
                  }
                })
              }
            />
          </View>
        </>
      ) : issue ? (
        <>
          <Text className="text-xs text-foreground-muted">
            {issue.identifier} · {issue.state.name} · {issue.priorityLabel}
          </Text>
          <Text className="text-xl font-t3-bold text-foreground">{issue.title}</Text>
          <Text className="text-foreground-muted">
            {issue.assignee?.name ?? "Unassigned"} · {issue.project?.name ?? "No project"}
          </Text>
          <Markdown text={issue.description} />
          <View className="flex-row flex-wrap gap-2">
            <Button
              label="Edit issue"
              disabled={!canWrite}
              onPress={() => {
                setTitle(issue.title);
                setDescription(issue.description ?? "");
                setState(issue.state.id);
                setAssignee(issue.assignee?.id ?? "");
                setPriority(String(issue.priority));
                setEditing(true);
              }}
            />
            <Button
              label={issue.archivedAt ? "Restore" : "Archive"}
              disabled={!canWrite}
              onPress={() =>
                void mutate({
                  kind: issue.archivedAt ? "issueUnarchive" : "issueArchive",
                  id: issue.id,
                })
              }
            />
          </View>
          <Text className="font-t3-bold text-foreground">Discussion</Text>
          {comments.error && <Notice>{comments.error}</Notice>}
          {comments.data?.nodes.map((item) => (
            <View key={item.id} className="gap-2 rounded-lg border border-divider p-3">
              <Text className="text-xs text-foreground-muted">
                {item.user?.name ?? "Member"} · {new Date(item.createdAt).toLocaleDateString()}
              </Text>
              <Markdown text={item.body} />
            </View>
          ))}
          <View className="flex-row gap-2">
            <Button
              label="Previous comments"
              disabled={!after || comments.isPending}
              onPress={() => setCursors((values) => values.slice(0, -1))}
            />
            <Button
              label="More comments"
              disabled={!comments.data?.pageInfo.hasNextPage || comments.isPending}
              onPress={() => {
                const cursor = comments.data?.pageInfo.endCursor;
                if (cursor) setCursors((values) => [...values, cursor]);
              }}
            />
          </View>
          <Field label="Comment (Markdown)" value={comment} onChange={setComment} multiline />
          <Button
            label="Post comment"
            disabled={!canWrite || !comment.trim()}
            onPress={() =>
              void mutate({
                kind: "commentCreate",
                input: { issueId: issue.id, body: comment },
              }).then((ok) => {
                if (ok) setComment((current) => (current === comment ? "" : current));
              })
            }
          />
        </>
      ) : (
        <Notice>Loading issue…</Notice>
      )}
    </>
  );
}
