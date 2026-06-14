/**
 * Planning space fixtures — fully SYNTHETIC backlog snapshot that mirrors the
 * statistical shape of a real planning-day sprint (spec §10.3): subtask-shaped
 * sprint (subtasks carry the hour estimates), context parents outside the
 * sprint, wide-shallow epic fan-out, 18 assignees, long German titles, one
 * emoji-prefixed epic, ~50% resolved late-sprint state.
 *
 * PRIVACY: every person, key, epic and title in this file is invented for a
 * fictional fleet-dispatch product. Never paste real project data here.
 */

import type { ProjectTicket } from "~/t3work/t3work-types";

export const PLANNING_SPACE_FIXTURE_SPRINT_ID = "sprint-76";
const SPRINT_NAME = "Dispo Sprint 6.4";

/** Synthetic team — names are invented; roles feed the skill grouping. */
export const PLANNING_SPACE_FIXTURE_PEOPLE: ReadonlyArray<{
  readonly name: string;
  readonly role: "Frontend" | "Backend" | "Mobile" | "QA" | "DevOps";
}> = [
  { name: "Lena Achermann", role: "Frontend" },
  { name: "Jonah Bieri", role: "Backend" },
  { name: "Mara Castellan", role: "QA" },
  { name: "Timo Degen", role: "Frontend" },
  { name: "Selina Egger", role: "Backend" },
  { name: "Ruben Fankhauser", role: "Mobile" },
  { name: "Noemi Gisler", role: "QA" },
  { name: "Cyrill Hauri", role: "Backend" },
  { name: "Ivana Jucker", role: "Frontend" },
  { name: "Levin Kradolfer", role: "Mobile" },
  { name: "Aline Lüscher", role: "Backend" },
  { name: "Mattia Neuhaus", role: "DevOps" },
  { name: "Olivia Portmann", role: "Frontend" },
  { name: "Silvan Rentsch", role: "Mobile" },
  { name: "Tabea Schwander", role: "QA" },
  { name: "Diego Tanner", role: "Backend" },
  { name: "Flurina Utzinger", role: "DevOps" },
  { name: "Basil Wirthlin", role: "Frontend" },
];

/** Back-compat alias for earlier story imports. */
export const planningSpaceFixturePeople = PLANNING_SPACE_FIXTURE_PEOPLE;

export const PLANNING_SPACE_FIXTURE_OWNER_ROLES: ReadonlyMap<string, string> =
  new Map(
    PLANNING_SPACE_FIXTURE_PEOPLE.map((person) => [
      `acc-${person.name}`,
      person.role,
    ]),
  );

interface FixtureStory {
  readonly key: string;
  readonly title: string;
  readonly epicKey: string | null;
  readonly type: "Story" | "Bug" | "Admintask";
  readonly assignee: string | null;
  readonly inSprint: boolean;
  readonly resolved?: boolean;
  readonly ownHours?: number;
  readonly description?: string;
  readonly subtasks?: ReadonlyArray<{
    readonly title: string;
    readonly assignee: string | null;
    readonly hours: number;
    readonly resolved?: boolean;
  }>;
}

const EPICS: ReadonlyArray<{ key: string; title: string }> = [
  { key: "EP-210", title: "210 Teil 1 Einsatzmittel- und Auftragsdisposition" },
  { key: "EP-301", title: "Dokumentenablage Fahrzeuge Teil 1" },
  { key: "EP-118", title: "Übergreifende Hilfetexte (Handbuch-Niveau)" },
  { key: "EP-455", title: "Nacharbeiten aus Release R-4" },
  { key: "EP-512", title: "Schnittstellen Disposition POC" },
  { key: "EP-302", title: "Dokumentenablage Touren Teil 2" },
  { key: "EP-640", title: "Native Apps - R-6" },
  { key: "EP-208", title: "208 Tour begleiten Teil 1" },
  { key: "EP-510", title: "🚨💰 510 Berechtigungen verwalten" },
  { key: "EP-133", title: "Alternative Anmeldung für die Arbeit im Depot" },
  { key: "EP-720", title: "Technische Updates und Wartung R-6" },
  { key: "EP-815", title: "Freie Auswertungen Teil 3/5: Berichte verwalten" },
  { key: "EP-900", title: "Replanning für finalen Umfang GO-Live 19.10.2026" },
];

const H = 3600;

const STORIES: ReadonlyArray<FixtureStory> = [
  {
    key: "FLT-20508",
    title:
      "TMS Depotkapazitäten -> Anbindung der Dispositionsaggregate + Codes wandern in die Schnittstellenkonfiguration",
    epicKey: "EP-512",
    type: "Story",
    assignee: "Lena Achermann",
    inSprint: true,
    description:
      "Die Kapazitätsmeldungen des Depot-Systems werden über die neue Schnittstelle eingelesen und den Dispositionsaggregaten zugeordnet.",
    subtasks: [
      { title: "Implementation 1 Quellsystem", assignee: "Lena Achermann", hours: 10 * H },
      { title: "Implementation Multi-Quellen", assignee: "Lena Achermann", hours: 10 * H },
      { title: "Unittests", assignee: "Lena Achermann", hours: 8 * H },
      { title: "Review Backend", assignee: "Jonah Bieri", hours: 4 * H },
      { title: "Review Schnittstellenkonzept", assignee: "Cyrill Hauri", hours: 6 * H },
    ],
  },
  {
    key: "FLT-20507",
    title: "Mock/Testbench CLI zum Auslösen von TMS-Meldungen",
    epicKey: "EP-512",
    type: "Story",
    assignee: "Selina Egger",
    inSprint: true,
    subtasks: [
      { title: "CLI-Implementation", assignee: "Selina Egger", hours: 10 * H },
      { title: "Review", assignee: "Cyrill Hauri", hours: 1 * H },
    ],
  },
  {
    key: "FLT-20070",
    title: "ENABLER Reaktion auf DepotChanged analysieren - Einsatzplanung",
    epicKey: "EP-210",
    type: "Story",
    assignee: "Diego Tanner",
    inSprint: true,
    ownHours: 8 * H,
  },
  {
    key: "FLT-20084",
    title: "Web: Verlauf Ereignistyp-Filter nicht scrollbar",
    epicKey: "EP-720",
    type: "Bug",
    assignee: "Mara Castellan",
    inSprint: true,
    resolved: true,
  },
  {
    key: "FLT-20167",
    title: "Mobile Pentest-Findings umsetzen",
    epicKey: "EP-640",
    type: "Story",
    assignee: "Silvan Rentsch",
    inSprint: true,
    subtasks: [
      { title: "iOS: Pentest-Findings umsetzen", assignee: "Ruben Fankhauser", hours: 2 * H, resolved: true },
      { title: "Android/KMP: Pentest-Findings umsetzen", assignee: "Silvan Rentsch", hours: 8 * H },
    ],
  },
  {
    key: "FLT-20171",
    title:
      "Dokumentation technische Grundlagen für alternative Anmelde-Methoden",
    epicKey: "EP-133",
    type: "Story",
    assignee: "Aline Lüscher",
    inSprint: true,
    resolved: true,
    subtasks: [
      { title: "Konzept + Doku", assignee: "Aline Lüscher", hours: 16 * H, resolved: true },
      { title: "Informationen einholen", assignee: "Aline Lüscher", hours: 6 * H, resolved: true },
    ],
  },
  {
    key: "FLT-20188",
    title: "Fix für Fahrzeugfotos auf Staging bringen",
    epicKey: "EP-301",
    type: "Bug",
    assignee: "Mattia Neuhaus",
    inSprint: true,
    resolved: true,
    ownHours: 2 * H,
  },
  {
    key: "FLT-20243",
    title: "SPIKE Pro & Contra für Sandbox/Produktiv-Berichterstellung",
    epicKey: "EP-815",
    type: "Story",
    assignee: "Jonah Bieri",
    inSprint: true,
    resolved: true,
  },
  {
    key: "FLT-20268",
    title: "Vorbereitung / Durchführung Abnahmetest",
    epicKey: "EP-720",
    type: "Admintask",
    assignee: "Noemi Gisler",
    inSprint: true,
    resolved: true,
    ownHours: 6 * H,
  },
  {
    key: "FLT-20338",
    title:
      "iOS: Scanner-Lizenzschlüssel aktualisiert sich nicht aus Remote-Config",
    epicKey: "EP-640",
    type: "Bug",
    assignee: "Levin Kradolfer",
    inSprint: true,
    ownHours: 6 * H,
  },
  {
    key: "FLT-20403",
    title: "Verbesserungen Ankunftszeit-Berechnung",
    epicKey: "EP-208",
    type: "Story",
    assignee: "Diego Tanner",
    inSprint: true,
    subtasks: [
      { title: "Umsetzung Verbesserungen", assignee: "Diego Tanner", hours: 8 * H, resolved: true },
      { title: "Review Verbesserungen", assignee: "Jonah Bieri", hours: 3 * H },
    ],
  },
  {
    key: "FLT-20537",
    title:
      "Web Beobachtung: Ein Benutzer wird gelöscht -> Bereich Chat ist nicht mehr verfügbar",
    epicKey: "EP-510",
    type: "Bug",
    assignee: null,
    inSprint: true,
    resolved: true,
  },
  {
    key: "FLT-20591",
    title:
      "WEB Dokumentenablage Foto: wenn ein neues Fahrzeug erstellt und das Foto angepasst wird -> altes Foto wird im Web nicht automatisch gelöscht",
    epicKey: "EP-302",
    type: "Bug",
    assignee: null,
    inSprint: true,
  },
  {
    key: "FLT-20668",
    title:
      'Web Dokumentenablage Anzeige: Datei nicht für die Einheit freigegeben -> Kennzeichen "mit mir geteilt" wird trotzdem gesetzt',
    epicKey: "EP-301",
    type: "Bug",
    assignee: null,
    inSprint: true,
  },
  {
    key: "FLT-20909",
    title: "ENABLER Klärung Integrations-Event Check-in/Check-out der Fahrer",
    epicKey: "EP-900",
    type: "Story",
    assignee: "Flurina Utzinger",
    inSprint: true,
    ownHours: 4 * H,
  },
  // --- context parents: outside the sprint, their subtasks are in it -------
  {
    key: "FLT-13065",
    title: "Dispo Transport: Karte mit Tourleistungen",
    epicKey: "EP-210",
    type: "Story",
    assignee: "Mara Castellan",
    inSprint: false,
    subtasks: [
      { title: "Frontend", assignee: "Basil Wirthlin", hours: 16 * H, resolved: true },
      { title: "Frontend Review", assignee: "Ivana Jucker", hours: 2 * H, resolved: true },
      { title: "Backend-Mock", assignee: "Jonah Bieri", hours: 6 * H, resolved: true },
      { title: "Backend-Mock Review", assignee: "Selina Egger", hours: 6 * H, resolved: true },
      { title: "Karten-Backend Umsetzung", assignee: "Cyrill Hauri", hours: 16 * H, resolved: true },
      { title: "Testing", assignee: "Mara Castellan", hours: 4 * H },
    ],
  },
  {
    key: "FLT-17877",
    title: "Stammdaten der Niederlassung importieren",
    epicKey: "EP-455",
    type: "Story",
    assignee: "Mara Castellan",
    inSprint: false,
    subtasks: [
      { title: "Backend", assignee: "Diego Tanner", hours: 10 * H, resolved: true },
      { title: "Frontend + Import-Modal", assignee: "Timo Degen", hours: 16 * H, resolved: true },
      { title: "Frontend-Review", assignee: "Olivia Portmann", hours: 2 * H, resolved: true },
      { title: "Review Import gesamt", assignee: "Selina Egger", hours: 1 * H, resolved: true },
      { title: "Testing", assignee: "Mara Castellan", hours: 6 * H },
    ],
  },
  {
    key: "FLT-18221",
    title: "Web: Enabler / Vorarbeiten Tour begleiten Teil 2 Karte",
    epicKey: "EP-208",
    type: "Story",
    assignee: "Basil Wirthlin",
    inSprint: false,
    subtasks: [
      { title: "Karten-Grundgerüst Restrukturierung der bestehenden Read-Only-Karte", assignee: "Basil Wirthlin", hours: 12 * H, resolved: true },
      { title: "Karten-Restrukturierung mit neuem Event-Sourcing-Teil", assignee: "Basil Wirthlin", hours: 16 * H, resolved: true },
      { title: "Neue Karte Vorbereitung und Deployment", assignee: "Mattia Neuhaus", hours: 12 * H, resolved: true },
      { title: "Karten-Routing Integration", assignee: "Basil Wirthlin", hours: 20 * H },
      { title: "Karten-Review und Besprechung", assignee: "Diego Tanner", hours: 16 * H },
      { title: "Altes Routing von Fachlogik räumen (nur Build bleibt)", assignee: "Basil Wirthlin", hours: 2 * H },
    ],
  },
  {
    key: "FLT-16950",
    title: "Web: Exemplarischer Einbau Online-Hilfe",
    epicKey: "EP-118",
    type: "Story",
    assignee: "Ivana Jucker",
    inSprint: false,
    subtasks: [
      { title: 'Hauptscreen "Hilfe" implementieren', assignee: "Ivana Jucker", hours: 12 * H, resolved: true },
      { title: 'Hauptscreen "Modal" implementieren', assignee: "Ivana Jucker", hours: 12 * H, resolved: true },
      { title: "Seitenleiste implementieren", assignee: "Ivana Jucker", hours: 8 * H, resolved: true },
      { title: "Permalink-Komponente implementieren", assignee: "Ivana Jucker", hours: 2 * H, resolved: true },
      { title: '"Hilfe" im Dialog-Header implementieren', assignee: "Ivana Jucker", hours: 4 * H },
    ],
  },
  {
    key: "FLT-18942",
    title: "Native: Besatzung durch System anpassen",
    epicKey: "EP-210",
    type: "Story",
    assignee: "Ruben Fankhauser",
    inSprint: false,
    subtasks: [
      { title: "KMP: Besatzung durch System anpassen", assignee: "Levin Kradolfer", hours: 12 * H, resolved: true },
      { title: "iOS: Besatzung durch System anpassen", assignee: "Ruben Fankhauser", hours: 2 * H },
      { title: "Android: Besatzung durch System anpassen", assignee: "Silvan Rentsch", hours: 2 * H },
      { title: "QA: Besatzung durch System anpassen", assignee: "Tabea Schwander", hours: 4 * H },
    ],
  },
  {
    key: "FLT-19929",
    title: "Web: Enabler Backend für Einbau Online-Hilfe",
    epicKey: "EP-118",
    type: "Story",
    assignee: "Cyrill Hauri",
    inSprint: false,
    resolved: true,
    ownHours: 8 * H,
    subtasks: [
      { title: "Reviews + Hinterfragen", assignee: "Diego Tanner", hours: 3 * H },
    ],
  },
];

function statusOf(resolved: boolean | undefined): string {
  return resolved ? "Erledigt" : "In Arbeit";
}

export function planningSpaceFixtureTickets(): ProjectTicket[] {
  const tickets: ProjectTicket[] = [];
  const now = "2026-06-10T08:00:00Z";
  for (const epic of EPICS) {
    tickets.push({
      id: epic.key,
      projectId: "fixture-project",
      ref: {
        provider: "atlassian",
        kind: "jira-issue",
        id: epic.key,
        displayId: epic.key,
        title: epic.title,
        url: `https://example.invalid/browse/${epic.key}`,
        projectId: "fixture-project",
      },
      issueType: "Epic",
      issueTypeIsSubtask: false,
      status: "In Arbeit",
      updatedAt: now,
    });
  }
  for (const story of STORIES) {
    tickets.push({
      id: story.key,
      projectId: "fixture-project",
      ...(story.epicKey ? { parentId: story.epicKey } : {}),
      ref: {
        provider: "atlassian",
        kind: "jira-issue",
        id: story.key,
        displayId: story.key,
        title: story.title,
        url: `https://example.invalid/browse/${story.key}`,
        projectId: "fixture-project",
      },
      issueType: story.type,
      issueTypeIsSubtask: false,
      status: statusOf(story.resolved),
      ...(story.assignee
        ? {
            assignee: story.assignee,
            assigneeAccountId: `acc-${story.assignee}`,
          }
        : {}),
      ...(story.ownHours !== undefined
        ? { timeOriginalEstimateSeconds: story.ownHours }
        : {}),
      ...(story.description !== undefined
        ? { description: story.description }
        : {}),
      ...(story.inSprint
        ? {
            sprintId: PLANNING_SPACE_FIXTURE_SPRINT_ID,
            sprintName: SPRINT_NAME,
            sprintState: "active",
          }
        : {}),
      updatedAt: now,
    });
    (story.subtasks ?? []).forEach((subtask, index) => {
      const id = `${story.key}-S${index + 1}`;
      tickets.push({
        id,
        projectId: "fixture-project",
        parentId: story.key,
        ref: {
          provider: "atlassian",
          kind: "jira-issue",
          id,
          displayId: id,
          title: subtask.title,
          url: `https://example.invalid/browse/${id}`,
          projectId: "fixture-project",
        },
        issueType: "Task",
        issueTypeIsSubtask: true,
        status: statusOf(subtask.resolved),
        ...(subtask.assignee
          ? {
              assignee: subtask.assignee,
              assigneeAccountId: `acc-${subtask.assignee}`,
            }
          : {}),
        timeOriginalEstimateSeconds: subtask.hours,
        sprintId: PLANNING_SPACE_FIXTURE_SPRINT_ID,
        sprintName: SPRINT_NAME,
        sprintState: "active",
        updatedAt: now,
      });
    });
  }
  return tickets;
}
