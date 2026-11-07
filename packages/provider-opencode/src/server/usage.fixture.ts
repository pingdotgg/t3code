/**
 * Rows recorded from an isolated `@opencode/cli@2.1.2` data directory: one imported
 * session with a single assistant reply, a fork of it, and a fork of that fork
 * moved to another directory. No model request was made after the import, so
 * every assistant row here describes the same provider request.
 */
export const openCodeForkSchema = [
  // Recorded verbatim, except the project foreign key, whose table the reader never reads.
  `CREATE TABLE \`session_v2\` (
    \`id\` text PRIMARY KEY,
    \`project_id\` text NOT NULL,
    \`workspace_id\` text,
    \`parent_id\` text,
    \`fork_session_id\` text,
    \`fork_boundary\` text,
    \`slug\` text NOT NULL,
    \`directory\` text NOT NULL,
    \`path\` text,
    \`title\` text,
    \`version\` text NOT NULL,
    \`share_url\` text,
    \`summary_additions\` integer,
    \`summary_deletions\` integer,
    \`summary_files\` integer,
    \`summary_diffs\` text,
    \`metadata\` text,
    \`cost\` real DEFAULT 0 NOT NULL,
    \`tokens_input\` integer DEFAULT 0 NOT NULL,
    \`tokens_output\` integer DEFAULT 0 NOT NULL,
    \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
    \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
    \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
    \`revert\` text,
    \`permission\` text,
    \`agent\` text,
    \`model\` text,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`time_idle\` integer,
    \`time_viewed\` integer,
    \`idle_outcome\` text,
    \`time_compacting\` integer,
    \`time_archived\` integer,
    \`time_suspended\` integer,
    \`resume_attempts\` integer DEFAULT 0 NOT NULL
  )`,
  `CREATE TABLE \`session_message\` (
    \`id\` text PRIMARY KEY,
    \`session_id\` text NOT NULL,
    \`type\` text NOT NULL,
    \`seq\` integer NOT NULL,
    \`time_created\` integer NOT NULL,
    \`time_updated\` integer NOT NULL,
    \`data\` text NOT NULL,
    CONSTRAINT \`fk_session_message_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
  )`,
] as const;

export const openCodeForkSourceSessionId = "ses_e9f85baeeffec3vOG8D972DJeK";
export const openCodeForkSourceAssistantId = "msg_usageproofassistant0000001";
export const openCodeForkContinuationSessionId = "ses_e9f847594ffetYJnuLwILjFktF";

export const openCodeForkSessions = [
  {
    id: openCodeForkSourceSessionId,
    project_id: "66c815350f7a94ca31c5664e5e983b8692210bdc",
    fork_session_id: null,
    fork_boundary: null,
    slug: "mighty-engine",
    directory: "/home/ubuntu/wt/issue-23104",
    version: "2.1.2",
    time_created: 1792619988283,
    time_updated: 1792620016405,
  },
  {
    id: "ses_e9f854c73ffezSCt9xY4yA99bP",
    project_id: "66c815350f7a94ca31c5664e5e983b8692210bdc",
    fork_session_id: openCodeForkSourceSessionId,
    fork_boundary: `{"type":"through","messageID":"${openCodeForkSourceAssistantId}"}`,
    slug: "silent-meadow",
    directory: "/home/ubuntu/wt/issue-23104",
    version: "2.1.2",
    time_created: 1792620016526,
    time_updated: 1792620016526,
  },
  {
    id: openCodeForkContinuationSessionId,
    project_id: "98021609e205cae99a3b3545f6e3643a33b807b5",
    fork_session_id: "ses_e9f854c73ffezSCt9xY4yA99bP",
    fork_boundary: '{"type":"through","messageID":"msg_1607ab38e001GxURO0NU4GY4Az_2"}',
    slug: "playful-star",
    directory: "/tmp/triage-23104",
    version: "2.1.2",
    time_created: 1792620071533,
    time_updated: 1792620071833,
  },
] as const;

const userData = '{"time":{"created":1792619988283},"text":"Say usage proof"}';
const assistantData =
  '{"time":{"created":1792619988284,"completed":1792619988285},"agent":"build","model":{"id":"claude-sonnet-4-5","providerID":"anthropic"},"content":[{"type":"text","text":"usage proof"}],"finish":"stop","cost":0.01,"tokens":{"input":1000,"output":200,"reasoning":0,"cache":{"read":300,"write":0}}}';

export const openCodeForkMessages = [
  {
    id: "msg_usageproofuser0000000000001",
    session_id: openCodeForkSourceSessionId,
    type: "user",
    seq: 1,
    time_created: 1792619988283,
    time_updated: 1792620016408,
    data: userData,
  },
  {
    id: openCodeForkSourceAssistantId,
    session_id: openCodeForkSourceSessionId,
    type: "assistant",
    seq: 2,
    time_created: 1792619988284,
    time_updated: 1792620016408,
    data: assistantData,
  },
  {
    id: "msg_1607ab38e001GxURO0NU4GY4Az_1",
    session_id: "ses_e9f854c73ffezSCt9xY4yA99bP",
    type: "user",
    seq: 1,
    time_created: 1792619988283,
    time_updated: 1792620016408,
    data: userData,
  },
  {
    id: "msg_1607ab38e001GxURO0NU4GY4Az_2",
    session_id: "ses_e9f854c73ffezSCt9xY4yA99bP",
    type: "assistant",
    seq: 2,
    time_created: 1792619988284,
    time_updated: 1792620016408,
    data: assistantData,
  },
  {
    id: "msg_1607b8a6d001MA7a5GgmyUywMf_1",
    session_id: openCodeForkContinuationSessionId,
    type: "user",
    seq: 1,
    time_created: 1792619988283,
    time_updated: 1792620016408,
    data: userData,
  },
  {
    id: "msg_1607b8a6d001MA7a5GgmyUywMf_2",
    session_id: openCodeForkContinuationSessionId,
    type: "assistant",
    seq: 2,
    time_created: 1792619988284,
    time_updated: 1792620016408,
    data: assistantData,
  },
  {
    id: "msg_1607b8b990025w0634bKiaIXmD",
    session_id: openCodeForkContinuationSessionId,
    type: "location-switched",
    seq: 6,
    time_created: 1792620071833,
    time_updated: 1792620071838,
    data: '{"time":{"created":1792620071833},"location":{"directory":"/tmp/triage-23104"},"projectID":"98021609e205cae99a3b3545f6e3643a33b807b5","subpath":"","previous":{"location":{"directory":"/home/ubuntu/wt/issue-23104"},"projectID":"66c815350f7a94ca31c5664e5e983b8692210bdc","subpath":""}}',
  },
  {
    id: "msg_1607b8ba5001oCiDSgDjIcR3Nc",
    session_id: openCodeForkContinuationSessionId,
    type: "idle",
    seq: 7,
    time_created: 1792620071845,
    time_updated: 1792620071846,
    data: '{"time":{"created":1792620071845},"outcome":"succeeded"}',
  },
] as const;
