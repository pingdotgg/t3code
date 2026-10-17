import * as Schema from "effect/Schema";

import { decodeJsonResult } from "@t3tools/shared/schemaJson";

const WorkItem = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^gid:\/\/gitlab\/WorkItem\/[1-9]\d*$/)),
  iid: Schema.String.check(Schema.isPattern(/^[1-9]\d*$/)),
  title: Schema.NonEmptyString,
  webUrl: Schema.NonEmptyString,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  confidential: Schema.Boolean,
  archived: Schema.Boolean,
  namespace: Schema.Struct({ fullPath: Schema.NonEmptyString }),
  project: Schema.NullOr(Schema.Struct({ fullPath: Schema.NonEmptyString })),
  workItemType: Schema.Struct({ name: Schema.NonEmptyString }),
  userPermissions: Schema.Struct({ adminParentLink: Schema.Boolean }),
});
export type GitLabWorkItem = typeof WorkItem.Type;

const WorkItemWithHierarchy = Schema.Struct({
  ...WorkItem.fields,
  widgets: Schema.Array(
    Schema.Struct({
      __typename: Schema.String,
      parent: Schema.optional(Schema.NullOr(WorkItem)),
      children: Schema.optional(
        Schema.Struct({
          nodes: Schema.Array(WorkItem),
          pageInfo: Schema.Struct({
            hasNextPage: Schema.Boolean,
            endCursor: Schema.NullOr(Schema.String),
          }),
        }),
      ),
    }),
  ),
});
export type GitLabWorkItemWithHierarchy = typeof WorkItemWithHierarchy.Type;

const Actor = Schema.Struct({
  id: Schema.String,
  username: Schema.NonEmptyString,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
const EpicNote = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(Actor),
  body: Schema.String,
  system: Schema.Boolean,
  createdAt: Schema.String,
  lastEditedAt: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});
const EpicActivity = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      notes: Schema.Struct({
        nodes: Schema.Array(EpicNote),
        pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
      }),
    }),
  ),
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
});
export type GitLabEpicActivity = typeof EpicActivity.Type;
const Epic = Schema.Struct({
  ...WorkItem.fields,
  description: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Actor),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
  widgets: Schema.Array(
    Schema.Struct({
      __typename: Schema.String,
      assignees: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Actor) }))),
      labels: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            nodes: Schema.Array(
              Schema.Struct({ title: Schema.NonEmptyString, color: Schema.NullOr(Schema.String) }),
            ),
            pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
          }),
        ),
      ),
      notes: Schema.optional(
        Schema.Struct({
          nodes: Schema.Array(EpicNote),
          pageInfo: Schema.Struct({
            hasPreviousPage: Schema.Boolean,
            startCursor: Schema.NullOr(Schema.String),
          }),
        }),
      ),
      discussions: Schema.optional(Schema.NullOr(EpicActivity)),
    }),
  ),
});
export type GitLabEpic = typeof Epic.Type;

const WORK_ITEM_FIELDS = `id iid title webUrl state confidential archived
  namespace { fullPath } project { fullPath } workItemType { name }
  userPermissions { adminParentLink }`;
const PARENT_FIELDS = `parent { ${WORK_ITEM_FIELDS} }`;

export const WORK_ITEM_QUERY = `query($fullPath: ID!, $iid: String!) {
  namespace(fullPath: $fullPath) {
    workItem(iid: $iid) {
      ${WORK_ITEM_FIELDS}
      widgets { __typename ... on WorkItemWidgetHierarchy { ${PARENT_FIELDS} } }
    }
  }
}`;

export const WORK_ITEM_HIERARCHY_QUERY = `query($fullPath: ID!, $iid: String!, $first: Int!, $after: String) {
  namespace(fullPath: $fullPath) {
    workItem(iid: $iid) {
      ${WORK_ITEM_FIELDS}
      widgets { __typename ... on WorkItemWidgetHierarchy {
        ${PARENT_FIELDS}
        children(first: $first, after: $after) {
          nodes { ${WORK_ITEM_FIELDS} } pageInfo { hasNextPage endCursor }
        }
      } }
    }
  }
}`;

const EPIC_ACTIVITY_FIELDS = `nodes {
  notes(first: 1) {
    nodes { id body system createdAt lastEditedAt url author { id username name avatarUrl } }
    pageInfo { hasNextPage }
  }
} pageInfo { hasNextPage endCursor }`;

export const EPIC_QUERY = `query($fullPath: ID!, $iid: String!, $before: String, $includeHistory: Boolean!, $first: Int!, $after: String) {
  currentUser { username }
  namespace(fullPath: $fullPath) {
    workItem(iid: $iid) {
      ${WORK_ITEM_FIELDS}
      description createdAt updatedAt closedAt
      author { id username name avatarUrl }
      widgets { __typename
        ... on WorkItemWidgetAssignees { assignees(first: 100) { nodes { id username name avatarUrl } } }
        ... on WorkItemWidgetLabels { labels(first: 100) { nodes { title color } pageInfo { hasNextPage } } }
        ... on WorkItemWidgetNotes {
          notes(last: 100, before: $before) {
            nodes { id body system createdAt lastEditedAt url author { id username name avatarUrl } }
            pageInfo { hasPreviousPage startCursor }
          }
          discussions(first: $first, after: $after, filter: ONLY_ACTIVITY, sort: CREATED_DESC) @include(if: $includeHistory) {
            ${EPIC_ACTIVITY_FIELDS}
          }
        }
      }
    }
  }
}`;

export const EPIC_HISTORY_QUERY = `query($fullPath: ID!, $iid: String!, $first: Int!, $after: String) {
  namespace(fullPath: $fullPath) {
    workItem(iid: $iid) {
      ${WORK_ITEM_FIELDS}
      widgets { __typename ... on WorkItemWidgetNotes {
        discussions(first: $first, after: $after, filter: ONLY_ACTIVITY, sort: CREATED_DESC) {
          ${EPIC_ACTIVITY_FIELDS}
        }
      } }
    }
  }
}`;

export const WORK_ITEM_PARENT_MUTATION = `mutation($input: WorkItemUpdateInput!) {
  workItemUpdate(input: $input) {
    errors
    workItem {
      ${WORK_ITEM_FIELDS}
      widgets { __typename ... on WorkItemWidgetHierarchy { ${PARENT_FIELDS} } }
    }
  }
}`;

export const decodeWorkItemEnvelope = decodeJsonResult(
  Schema.Struct({
    errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
  }),
);
export const decodeWorkItemJson = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      namespace: Schema.NullOr(Schema.Struct({ workItem: Schema.NullOr(WorkItemWithHierarchy) })),
    }),
  }),
);
export const decodeEpicJson = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      currentUser: Schema.NullOr(Schema.Struct({ username: Schema.NonEmptyString })),
      namespace: Schema.NullOr(Schema.Struct({ workItem: Schema.NullOr(Epic) })),
    }),
  }),
);
export const decodeEpicHistoryJson = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      namespace: Schema.NullOr(
        Schema.Struct({
          workItem: Schema.NullOr(
            Schema.Struct({
              ...WorkItem.fields,
              widgets: Schema.Array(
                Schema.Struct({
                  __typename: Schema.String,
                  discussions: Schema.optional(Schema.NullOr(EpicActivity)),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  }),
);
export const decodeWorkItemMutationJson = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      workItemUpdate: Schema.Struct({
        errors: Schema.Array(Schema.String),
        workItem: Schema.NullOr(WorkItemWithHierarchy),
      }),
    }),
  }),
);
