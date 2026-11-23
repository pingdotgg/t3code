import { waitingForUser, WORKSTREAM_STATES } from "@t3tools/client-runtime/state/kompas";
import type { Workstream, WorkstreamThreadState } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { Bar, Card, KompasPage } from "./KompasPage";
import { MemoryScopeCard } from "./MemoryScreen";
import { type Kompas, kompasEnvironment, reportFailure, useKompas, useOpenThread } from "./state";

const progress = ({ threads }: Workstream) =>
  threads.length === 0
    ? 0
    : threads.filter((thread) => thread.state === "resolved").length / threads.length;

function Progress({ workstream }: { readonly workstream: Workstream }) {
  const gt = useGT();
  const label = gt("{done} of {total} threads done", {
    done: workstream.threads.filter((thread) => thread.state === "resolved").length,
    total: workstream.threads.length,
  });
  return (
    <View className="flex-row items-center gap-3">
      <Bar value={progress(workstream)} label={label} />
      <Text className="text-xs text-foreground-muted">{label}</Text>
    </View>
  );
}

export function WorkstreamsScreen() {
  const gt = useGT();
  const navigation = useNavigation();
  return (
    <KompasPage title={gt("Projects")} tab>
      {({ snapshot }) =>
        snapshot.workstreams.length === 0 ? (
          <EmptyState
            variant="plain"
            title={gt("No projects yet")}
            detail={gt("Create one on your computer; its threads show up here.")}
          />
        ) : (
          snapshot.workstreams.map((workstream) => {
            const waiting = waitingForUser(workstream);
            return (
              <Pressable
                key={workstream.id}
                accessibilityRole="button"
                className="active:opacity-70"
                onPress={() => navigation.navigate("KompasWorkstream", { id: workstream.id })}
              >
                <Card>
                  <View className="flex-row items-center gap-2">
                    <Text className="flex-1 font-t3-bold text-base" numberOfLines={1}>
                      {workstream.title}
                    </Text>
                    {waiting === 0 ? null : (
                      <Text className="font-t3-medium text-xs text-warning-foreground">
                        {gt("Waiting for you: {count}", { count: waiting })}
                      </Text>
                    )}
                  </View>
                  {workstream.goal === "" ? null : (
                    <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                      {workstream.goal}
                    </Text>
                  )}
                  <Progress workstream={workstream} />
                </Card>
              </Pressable>
            );
          })
        )
      }
    </KompasPage>
  );
}

function Threads(props: { readonly kompas: Kompas; readonly workstream: Workstream }) {
  const gt = useGT();
  const openThread = useOpenThread();
  const { environmentId } = props.kompas;
  const { workstream } = props;
  const labels: Record<WorkstreamThreadState, string> = {
    needs_input: gt("Waiting for you"),
    working: gt("Working"),
    idle: gt("Ready to check"),
    failed: gt("Failed"),
    resolved: gt("Done"),
  };
  return (
    <>
      <Button
        tone="primary"
        fullWidth
        label={gt("Talk to the coordinator")}
        onPress={() => openThread(environmentId, workstream.coordinatorThreadId)}
      />
      {WORKSTREAM_STATES.map((state) => {
        const threads = workstream.threads.filter((thread) => thread.state === state);
        if (threads.length === 0) return null;
        return (
          <SettingsSection key={state} title={`${labels[state]} · ${threads.length}`}>
            {threads.map((thread) => (
              <Pressable
                key={thread.threadId}
                accessibilityRole="button"
                className="gap-0.5 bg-grouped-card px-4 py-3 active:opacity-70"
                onPress={() => openThread(environmentId, thread.threadId)}
              >
                <Text className="font-t3-medium text-base">{thread.title}</Text>
                {thread.lastLine === null ? null : (
                  <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                    {thread.lastLine}
                  </Text>
                )}
              </Pressable>
            ))}
          </SettingsSection>
        );
      })}
    </>
  );
}

function Overview(props: { readonly kompas: Kompas; readonly workstream: Workstream }) {
  const gt = useGT();
  const { environmentId } = props.kompas;
  const { workstream } = props;
  const answerDecision = useAtomCommand(kompasEnvironment.answerDecision, { reportFailure: false });
  const resolveSuggestion = useAtomCommand(kompasEnvironment.resolveSuggestion, {
    reportFailure: false,
  });
  const answer = (id: string, text: string) =>
    void answerDecision({ environmentId, input: { id, answer: text } }).then(reportFailure);
  const resolve = (id: string, approve: boolean) =>
    void resolveSuggestion({ environmentId, input: { id, approve } }).then(reportFailure);
  return (
    <>
      <Progress workstream={workstream} />
      {workstream.decisions.map((decision) => (
        <Card key={decision.id} highlighted>
          <Text className="font-t3-medium text-sm text-primary">{gt("Decide")}</Text>
          <Text className="text-base">{decision.question}</Text>
          {decision.options.map((option) => (
            <Button
              key={option}
              fullWidth
              label={option}
              onPress={() => answer(decision.id, option)}
            />
          ))}
          <Button
            tone="text"
            label={gt("Your own answer")}
            onPress={() =>
              Dialog.prompt({
                title: decision.question,
                initialValue: "",
                confirmText: gt("Answer"),
                onConfirm: (text) => {
                  if (text.trim() !== "") answer(decision.id, text);
                },
              })
            }
          />
        </Card>
      ))}
      {workstream.suggestions.map((suggestion) => (
        <Card key={suggestion.id}>
          <Text className="font-t3-medium text-sm text-primary">{gt("Proposed thread")}</Text>
          <Text className="font-t3-medium text-base">{suggestion.title}</Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={5}>
            {suggestion.task}
          </Text>
          <View className="flex-row gap-2">
            <Button
              tone="primary"
              size="compact"
              label={gt("Start")}
              onPress={() => resolve(suggestion.id, true)}
            />
            <Button
              size="compact"
              label={gt("Dismiss")}
              onPress={() => resolve(suggestion.id, false)}
            />
          </View>
        </Card>
      ))}
      {workstream.goal === "" ? null : (
        <Card>
          <Text className="font-t3-medium text-sm">{gt("Goal")}</Text>
          <Text className="text-base text-foreground-muted">{workstream.goal}</Text>
        </Card>
      )}
    </>
  );
}

function Library(props: { readonly kompas: Kompas; readonly workstream: Workstream }) {
  const gt = useGT();
  const navigation = useNavigation();
  const { environmentId } = props.kompas;
  const add = useAtomCommand(kompasEnvironment.addLibraryItem, { reportFailure: false });
  const remove = useAtomCommand(kompasEnvironment.removeLibraryItem, { reportFailure: false });
  const [open, setOpen] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const save = async () => {
    const result = await add({
      environmentId,
      input: { workstreamId: props.workstream.id, kind: "note", title, content: note },
    });
    if (!reportFailure(result)) return;
    setTitle("");
    setNote("");
  };
  return (
    <>
      {props.workstream.library.map((item) => (
        <Card key={item.id}>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              item.kind === "deck"
                ? navigation.navigate("KompasDeck", { deckId: item.content })
                : setOpen(open === item.id ? null : item.id)
            }
          >
            <Text className="font-t3-medium text-base">{item.title}</Text>
          </Pressable>
          {open === item.id ? (
            <>
              <Text selectable className="text-sm text-foreground-muted">
                {item.content}
              </Text>
              <Button
                tone="text"
                size="compact"
                label={gt("Remove")}
                onPress={() =>
                  void remove({ environmentId, input: { id: item.id } }).then(reportFailure)
                }
              />
            </>
          ) : null}
        </Card>
      ))}
      <Card>
        <TextInput placeholder={gt("Title")} value={title} onChangeText={setTitle} />
        <TextInput multiline placeholder={gt("Note")} value={note} onChangeText={setNote} />
        <Button
          size="compact"
          label={gt("Add to library")}
          disabled={title.trim() === "" || note.trim() === ""}
          onPress={() => void save()}
        />
      </Card>
    </>
  );
}

function WorkstreamSettings(props: { readonly kompas: Kompas; readonly workstream: Workstream }) {
  const { workstream } = props;
  const { environmentId } = props.kompas;
  const gt = useGT();
  const update = useAtomCommand(kompasEnvironment.updateWorkstream, { reportFailure: false });
  const [title, setTitle] = useState(workstream.title);
  const [goal, setGoal] = useState(workstream.goal);
  const [instructions, setInstructions] = useState(workstream.instructions);
  const save = (askBeforeStart: boolean) =>
    void update({
      environmentId,
      input: {
        id: workstream.id,
        title,
        goal,
        instructions,
        askBeforeStart,
        threadModel: workstream.threadModel,
        maxParallelThreads: workstream.maxParallelThreads,
      },
    }).then(reportFailure);
  return (
    <>
      <Card>
        <TextInput accessibilityLabel={gt("Name")} value={title} onChangeText={setTitle} />
        <TextInput
          multiline
          placeholder={gt("Goal")}
          accessibilityLabel={gt("Goal")}
          value={goal}
          onChangeText={setGoal}
        />
        <TextInput
          multiline
          placeholder={gt("How to work")}
          accessibilityLabel={gt("How to work")}
          value={instructions}
          onChangeText={setInstructions}
        />
        <Button
          tone="primary"
          size="compact"
          label={gt("Save")}
          disabled={title.trim() === ""}
          onPress={() => save(workstream.askBeforeStart)}
        />
      </Card>
      <SettingsSection>
        <SettingsSwitchRow
          label={gt("Ask me before a thread starts")}
          value={workstream.askBeforeStart}
          onValueChange={save}
        />
      </SettingsSection>
    </>
  );
}

const TABS = ["threads", "overview", "library", "memory", "settings"] as const;
type Tab = (typeof TABS)[number];

function WorkstreamBody(props: { readonly kompas: Kompas; readonly workstream: Workstream }) {
  const { kompas, workstream } = props;
  const gt = useGT();
  const [tab, setTab] = useState<Tab>(waitingForUser(workstream) > 0 ? "overview" : "threads");
  const labels: Record<Tab, string> = {
    threads: gt("Threads"),
    overview: gt("Overview"),
    library: gt("Library"),
    memory: gt("Memory"),
    settings: gt("Settings"),
  };
  return (
    <>
      <SegmentedControl
        role="tab"
        size="compact"
        options={TABS.map((value) => ({ value, label: labels[value] }))}
        selected={tab}
        onSelect={setTab}
      />
      {tab === "threads" ? (
        <Threads kompas={kompas} workstream={workstream} />
      ) : tab === "overview" ? (
        <Overview kompas={kompas} workstream={workstream} />
      ) : tab === "library" ? (
        <Library kompas={kompas} workstream={workstream} />
      ) : tab === "memory" ? (
        <MemoryScopeCard
          kompas={kompas}
          scope={`project:${workstream.id}`}
          title={gt("Project memory")}
          detail={gt("Only this project's threads see it")}
        />
      ) : (
        <WorkstreamSettings kompas={kompas} workstream={workstream} />
      )}
    </>
  );
}

export function WorkstreamScreen({ route }: StaticScreenProps<{ readonly id: string }>) {
  const gt = useGT();
  const workstream = useKompas()?.snapshot.workstreams.find(
    (entry) => entry.id === route.params.id,
  );
  return (
    <KompasPage title={workstream?.title ?? gt("Project")}>
      {(kompas) =>
        workstream === undefined ? null : (
          <WorkstreamBody key={workstream.id} kompas={kompas} workstream={workstream} />
        )
      }
    </KompasPage>
  );
}
