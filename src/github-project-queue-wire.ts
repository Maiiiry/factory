const VALUE = `__typename
  ... on ProjectV2ItemFieldValueCommon {
    field { ... on ProjectV2FieldCommon { id } }
  }
  ... on ProjectV2ItemFieldTextValue { text }
  ... on ProjectV2ItemFieldNumberValue { number }`;
const CARD = `id isArchived project { id }
  content { __typename
    ... on Issue { id number repository { nameWithOwner } }
    ... on PullRequest { id repository { nameWithOwner } }
    ... on DraftIssue { id }
  }
  fieldValues(first:100) {
    nodes { ${VALUE} } pageInfo { hasNextPage endCursor }
  }`;
export const ADD = `mutation FactoryQueueEnsureCard($input:AddProjectV2ItemByIdInput!) {
  addProjectV2ItemById(input:$input) {
    clientMutationId item { ${CARD} }
  }
}`;
export const UPDATE = `mutation FactoryQueueSetField($input:UpdateProjectV2ItemFieldValueInput!) {
  updateProjectV2ItemFieldValue(input:$input) {
    clientMutationId projectV2Item { ${CARD} }
  }
}`;
export const BINDING = `query FactoryQueueBinding($project:ID!,$metadata:ID!,$order:ID!) {
  viewer { databaseId }
  project:node(id:$project) { __typename ... on ProjectV2 {
    id closed viewerCanUpdate
    owner { __typename ... on Organization { login } ... on User { login } }
  } }
  metadata:node(id:$metadata) { __typename ... on ProjectV2Field {
    id dataType project { id }
  } }
  order:node(id:$order) { __typename ... on ProjectV2Field {
    id dataType project { id }
  } }
}`;
export const ITEMS = `query FactoryQueueItems($project:ID!,$after:String) {
  node(id:$project) { __typename ... on ProjectV2 {
    id items(first:100,after:$after,archivedStates:[ARCHIVED,NOT_ARCHIVED]) {
      nodes { ${CARD} } pageInfo { hasNextPage endCursor }
    }
  } }
}`;
export const FIELDS = `query FactoryQueueItemFields($item:ID!,$after:String) {
  node(id:$item) { __typename ... on ProjectV2Item {
    id project { id } fieldValues(first:100,after:$after) {
      nodes { ${VALUE} } pageInfo { hasNextPage endCursor }
    }
  } }
}`;
export const ISSUE = `query FactoryQueueIssue($issue:ID!) {
  node(id:$issue) { __typename ... on Issue {
    id number title body state repository { nameWithOwner }
  } }
}`;

export const QUEUE_READ_QUERIES = Object.freeze([
  BINDING,
  ITEMS,
  FIELDS,
  ISSUE,
]);
export const QUEUE_WRITE_QUERIES = Object.freeze([ADD, UPDATE]);
