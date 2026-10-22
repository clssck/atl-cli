import { Type } from "../core/schema.ts";
import { check } from "../core/validate.ts";
import { defineCommand, type CommandContext, type CommandSpec } from "../core/cli.ts";
import { AtlError } from "../core/errors.ts";
import { graphql, GRAPHQL_URL, type GraphqlRequest } from "../core/graphql.ts";
import { isRecord } from "../core/guards.ts";
import { mapHttpError, type FetchLike } from "../core/http.ts";
import { openSession } from "../core/session.ts";
import { applyArgv, planOf } from "./write.ts";

export const compassGroups: Readonly<Record<string, string>> = {
  compass: "Compass components, relationships, and custom fields",
};

/** Test seam: a fake `fetch` used by every Compass command when set. */
export const compassDeps: { fetch?: FetchLike | undefined } = {};

// ---------------------------------------------------------------------------
// GraphQL documents. Compass lives under the `compass` root field of Query and Mutation.
// ---------------------------------------------------------------------------

const COMPONENT_FIELDS = "id name typeId description ownerId url labels { name }";
const ERROR_FIELDS = "message extensions { statusCode errorType }";

const SEARCH_COMPONENTS = `query CompassComponents($cloudId: String!, $query: CompassSearchComponentQuery) {
  compass {
    searchComponents(cloudId: $cloudId, query: $query) {
      __typename
      ... on CompassSearchComponentConnection {
        nodes { link component { ${COMPONENT_FIELDS} } }
        pageInfo { hasNextPage endCursor }
      }
      ... on QueryError { ${ERROR_FIELDS} }
    }
  }
}`;

const RELATIONSHIP_NODES = "nodes { relationshipType startNode { id name } endNode { id name } }";

// `CompassCustomSingleSelectField.option` is gated behind the gateway's `compass-beta` opt-in.
const GET_COMPONENT = `query CompassComponent($id: ID!, $customFields: Boolean!, $links: Boolean!, $relationships: Boolean!) {
  compass @optIn(to: "compass-beta") {
    component(id: $id) {
      __typename
      ... on CompassComponent {
        ${COMPONENT_FIELDS}
        customFields @include(if: $customFields) {
          __typename
          definition { __typename id name }
          ... on CompassCustomTextField { textValue }
          ... on CompassCustomNumberField { numberValue }
          ... on CompassCustomBooleanField { booleanValue }
          ... on CompassCustomUserField { userIdValue }
          ... on CompassCustomSingleSelectField { option { id value } }
          ... on CompassCustomMultiSelectField { options { id value } }
        }
        links @include(if: $links) { id type url name }
        dependsOn: relationships(query: {direction: OUTWARD, relationshipType: DEPENDS_ON, first: 50}) @include(if: $relationships) {
          __typename
          ... on CompassRelationshipConnection { ${RELATIONSHIP_NODES} }
          ... on QueryError { ${ERROR_FIELDS} }
        }
        dependencyOf: relationships(query: {direction: INWARD, relationshipType: DEPENDS_ON, first: 50}) @include(if: $relationships) {
          __typename
          ... on CompassRelationshipConnection { ${RELATIONSHIP_NODES} }
          ... on QueryError { ${ERROR_FIELDS} }
        }
        parents: relationships(query: {direction: OUTWARD, relationshipType: CHILD_OF, first: 50}) @include(if: $relationships) {
          __typename
          ... on CompassRelationshipConnection { ${RELATIONSHIP_NODES} }
          ... on QueryError { ${ERROR_FIELDS} }
        }
        children: relationships(query: {direction: INWARD, relationshipType: CHILD_OF, first: 50}) @include(if: $relationships) {
          __typename
          ... on CompassRelationshipConnection { ${RELATIONSHIP_NODES} }
          ... on QueryError { ${ERROR_FIELDS} }
        }
      }
      ... on QueryError { ${ERROR_FIELDS} }
    }
  }
}`;

const FIELD_DEFINITIONS = `query CompassCustomFieldDefinitions($query: CompassCustomFieldDefinitionsQuery!) {
  compass {
    customFieldDefinitions(query: $query) {
      __typename
      ... on CompassCustomFieldDefinitionsConnection {
        nodes { __typename id name description }
      }
      ... on QueryError { ${ERROR_FIELDS} }
    }
  }
}`;

const CREATE_COMPONENT = `mutation CompassCreateComponent($cloudId: ID!, $input: CreateCompassComponentInput!) {
  compass {
    createComponent(cloudId: $cloudId, input: $input) {
      success
      errors { ${ERROR_FIELDS} }
      componentDetails { ${COMPONENT_FIELDS} }
    }
  }
}`;

const CREATE_RELATIONSHIP = `mutation CompassCreateRelationship($input: CreateCompassRelationshipInput!) {
  compass {
    createRelationship(input: $input) {
      success
      errors { ${ERROR_FIELDS} }
      createdCompassRelationship { relationshipType startNode { id name } endNode { id name } }
    }
  }
}`;

const CREATE_FIELD_DEFINITION = `mutation CompassCreateCustomFieldDefinition($input: CompassCreateCustomFieldDefinitionInput!) {
  compass {
    createCustomFieldDefinition(input: $input) {
      success
      errors { ${ERROR_FIELDS} }
      customFieldDefinition { __typename id name description }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function inputError(code: string, message: string, hint?: string): AtlError {
  return new AtlError(message, {
    code,
    category: "input",
    ...(hint === undefined ? {} : { hint }),
  });
}

function unexpected(operationName: string): AtlError {
  return new AtlError(`Compass ${operationName} returned an unexpected payload`, {
    code: "unexpected_response",
    category: "api",
    hint: "Re-run with --full to see the raw payload.",
  });
}

async function readJsonObject(path: string, flag: string): Promise<Record<string, unknown>> {
  const text = await Bun.file(path)
    .text()
    .catch((cause: unknown) => {
      throw new AtlError(`Cannot read ${flag} ${path}`, {
        code: "input_file_unreadable",
        category: "input",
        cause,
      });
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new AtlError(`${flag} ${path} is not valid JSON`, {
      code: "invalid_json_file",
      category: "input",
      cause,
    });
  }
  if (!isRecord(parsed)) {
    throw inputError("invalid_json_file", `${flag} ${path} must contain a JSON object`);
  }
  return parsed;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Throw the AtlError for a GraphQL `QueryError` union member; return the record otherwise. */
function resolved(operationName: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw unexpected(operationName);
  }
  if (value.__typename === "QueryError") {
    // `QueryError.extensions` is a list in the schema; the first entry carries the status.
    const extensions = Array.isArray(value.extensions)
      ? value.extensions.find(isRecord)
      : undefined;
    const message = stringOf(value.message) ?? "Compass query failed";
    const status = typeof extensions?.statusCode === "number" ? extensions.statusCode : undefined;
    throw status === undefined
      ? new AtlError(`Compass ${operationName} failed: ${message}`, {
          code: "compass_query_error",
          category: "api",
        })
      : mapHttpError(
          "POST",
          `${GRAPHQL_URL}#${operationName}`,
          status,
          JSON.stringify({ message }),
        );
  }
  return value;
}

/** The `compass` root of a response's data. */
function compassRoot(
  operationName: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const root = data.compass;
  if (!isRecord(root)) {
    throw unexpected(operationName);
  }
  return root;
}

/** The payload of a mutation; `success: false` becomes an AtlError carrying the server messages. */
function mutationPayload(
  operationName: string,
  data: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const payload = compassRoot(operationName, data)[field];
  if (!isRecord(payload)) {
    throw unexpected(operationName);
  }
  if (payload.success !== true) {
    const errors = Array.isArray(payload.errors) ? payload.errors.filter(isRecord) : [];
    const messages = errors.map((error) => stringOf(error.message) ?? "unknown error");
    const first = errors[0];
    const extensions = first !== undefined && isRecord(first.extensions) ? first.extensions : {};
    const status = typeof extensions.statusCode === "number" ? extensions.statusCode : undefined;
    if (status !== undefined) {
      throw mapHttpError(
        "POST",
        `${GRAPHQL_URL}#${operationName}`,
        status,
        JSON.stringify({ message: messages.join("; ") }),
      );
    }
    throw new AtlError(
      `Compass ${operationName} failed: ${messages.join("; ") || "success was false"}`,
      { code: "compass_mutation_failed", category: "api" },
    );
  }
  return payload;
}

interface Operation {
  /** Writes honor `--plan`: they describe the exact request and send nothing. */
  write: boolean;
  build: (cloudId: string) => GraphqlRequest;
  /** Compact result; `--full` bypasses it and returns the raw response `data`. */
  shape: (data: Record<string, unknown>) => unknown;
}

async function execute(ctx: CommandContext, operation: Operation): Promise<unknown> {
  const session = await openSession(ctx, { fetch: compassDeps.fetch });
  const request = operation.build(session.site.cloudId);
  if (operation.write && ctx.plan) {
    return planOf(
      {
        method: "POST",
        url: GRAPHQL_URL,
        body: {
          operationName: request.operationName,
          query: request.query,
          variables: request.variables ?? {},
        },
      },
      [applyArgv(ctx.argv)],
    );
  }
  const { data } = await graphql(session.http, request);
  return ctx.full ? data : operation.shape(data);
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

interface CompactComponent {
  id: string | undefined;
  name: string | undefined;
  typeId: string | undefined;
  description: string | undefined;
  ownerId: string | undefined;
  labels: string[];
  url: string | undefined;
}

function compactComponent(component: Record<string, unknown>, link?: unknown): CompactComponent {
  const labels = Array.isArray(component.labels) ? component.labels : [];
  return {
    id: stringOf(component.id),
    name: stringOf(component.name),
    typeId: stringOf(component.typeId),
    description: stringOf(component.description),
    ownerId: stringOf(component.ownerId),
    labels: labels.flatMap((label) => {
      const name = isRecord(label) ? stringOf(label.name) : undefined;
      return name === undefined ? [] : [name];
    }),
    url: stringOf(link) ?? stringOf(component.url),
  };
}

const DEFINITION_TYPES: Readonly<Record<string, string>> = {
  CompassCustomTextFieldDefinition: "TEXT",
  CompassCustomNumberFieldDefinition: "NUMBER",
  CompassCustomBooleanFieldDefinition: "BOOLEAN",
  CompassCustomUserFieldDefinition: "USER",
  CompassCustomSingleSelectFieldDefinition: "SINGLE_SELECT",
  CompassCustomMultiSelectFieldDefinition: "MULTI_SELECT",
};

function compactDefinition(definition: Record<string, unknown>) {
  const typename = stringOf(definition.__typename);
  return {
    id: stringOf(definition.id),
    name: stringOf(definition.name),
    type: (typename === undefined ? undefined : DEFINITION_TYPES[typename]) ?? typename,
    description: stringOf(definition.description),
  };
}

function customFieldValue(field: Record<string, unknown>): unknown {
  switch (field.__typename) {
    case "CompassCustomTextField":
      return field.textValue;
    case "CompassCustomNumberField":
      return field.numberValue;
    case "CompassCustomBooleanField":
      return field.booleanValue;
    case "CompassCustomUserField":
      return field.userIdValue;
    case "CompassCustomSingleSelectField":
      return isRecord(field.option) ? stringOf(field.option.value) : undefined;
    case "CompassCustomMultiSelectField":
      return Array.isArray(field.options)
        ? field.options.filter(isRecord).map((option) => stringOf(option.value))
        : undefined;
    default:
      return undefined;
  }
}

function compactRelationships(operationName: string, component: Record<string, unknown>) {
  const groups = [
    { key: "dependsOn", type: "DEPENDS_ON", direction: "OUTWARD", other: "endNode" },
    { key: "dependencyOf", type: "DEPENDS_ON", direction: "INWARD", other: "startNode" },
    { key: "parents", type: "CHILD_OF", direction: "OUTWARD", other: "endNode" },
    { key: "children", type: "CHILD_OF", direction: "INWARD", other: "startNode" },
  ] as const;
  return groups.flatMap((group) => {
    const connection = resolved(operationName, component[group.key]);
    const nodes = Array.isArray(connection.nodes) ? connection.nodes.filter(isRecord) : [];
    return nodes.flatMap((node) => {
      const other = node[group.other];
      if (!isRecord(other)) {
        return [];
      }
      return [
        {
          type: group.type,
          direction: group.direction,
          component: { id: stringOf(other.id), name: stringOf(other.name) },
        },
      ];
    });
  });
}

function compactRelationship(relationship: Record<string, unknown>) {
  const node = (value: unknown) =>
    isRecord(value) ? { id: stringOf(value.id), name: stringOf(value.name) } : undefined;
  return {
    type: stringOf(relationship.relationshipType),
    from: node(relationship.startNode),
    to: node(relationship.endNode),
  };
}

// ---------------------------------------------------------------------------
// compass.components
// ---------------------------------------------------------------------------

const ComponentFilters = Type.Object(
  {
    types: Type.Optional(Type.Array(Type.String())),
    labels: Type.Optional(Type.Array(Type.String())),
    repositories: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

/** `--filters-file` entries become `fieldFilters` with `in` matching; empty lists are dropped. */
function fieldFilters(filters: Record<string, unknown>, path: string) {
  if (!check(ComponentFilters, filters)) {
    throw inputError(
      "invalid_filters_file",
      `--filters-file ${path} must be {"types"?: [], "labels"?: [], "repositories"?: []} with string arrays`,
    );
  }
  return [
    { name: "type", values: filters.types },
    { name: "labels", values: filters.labels },
    { name: "repositories", values: filters.repositories },
  ].flatMap(({ name, values }) =>
    values === undefined || values.length === 0 ? [] : [{ name, filter: { in: values } }],
  );
}

const components = defineCommand({
  name: "compass.components",
  summary: "Search Compass components",
  mcpTools: ["getCompassComponents"],
  args: [],
  flags: Type.Object({
    query: Type.Optional(Type.String({ description: "Text to search component names for" })),
    filtersFile: Type.Optional(
      Type.String({
        description: "JSON file with filters: {types?: [], labels?: [], repositories?: []}",
      }),
    ),
    after: Type.Optional(Type.String({ description: "Pagination cursor from a previous result" })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 50, description: "Items per page (default 10)" }),
    ),
  }),
  sideEffects: "none",
  examples: ["atl compass components --query payments --limit 20"],
  async run(ctx, input) {
    const { flags } = input;
    const filters =
      flags.filtersFile === undefined
        ? []
        : fieldFilters(
            await readJsonObject(flags.filtersFile, "--filters-file"),
            flags.filtersFile,
          );
    const operationName = "CompassComponents";
    return execute(ctx, {
      write: false,
      build: (cloudId) => ({
        operationName,
        query: SEARCH_COMPONENTS,
        variables: {
          cloudId,
          query: {
            ...(flags.query === undefined ? {} : { query: flags.query }),
            ...(filters.length === 0 ? {} : { fieldFilters: filters }),
            first: flags.limit ?? 10,
            ...(flags.after === undefined ? {} : { after: flags.after }),
          },
        },
      }),
      shape(data) {
        const result = resolved(operationName, compassRoot(operationName, data).searchComponents);
        const nodes = Array.isArray(result.nodes) ? result.nodes.filter(isRecord) : [];
        const pageInfo = isRecord(result.pageInfo) ? result.pageInfo : {};
        return {
          items: nodes.flatMap((node) =>
            isRecord(node.component) ? [compactComponent(node.component, node.link)] : [],
          ),
          nextCursor: pageInfo.hasNextPage === true ? stringOf(pageInfo.endCursor) : undefined,
        };
      },
    });
  },
});

// ---------------------------------------------------------------------------
// compass.component
// ---------------------------------------------------------------------------

const component = defineCommand({
  name: "compass.component",
  summary: "Get one Compass component",
  mcpTools: ["getCompassComponent"],
  args: [{ name: "id", description: "Component id or ARI", required: true }],
  flags: Type.Object({
    customFields: Type.Optional(
      Type.Boolean({ description: "Include custom fields (default true; --custom-fields=false)" }),
    ),
    relatedLinks: Type.Optional(
      Type.Boolean({ description: "Include related links (default true; --related-links=false)" }),
    ),
    relatedComponents: Type.Optional(
      Type.Boolean({
        description:
          "Include relationships: depends-on, dependency-of, parent and child components (default false)",
      }),
    ),
  }),
  sideEffects: "none",
  examples: ["atl compass component ari:cloud:compass:...:component/... --related-components"],
  run(ctx, input) {
    const { flags } = input;
    const operationName = "CompassComponent";
    return execute(ctx, {
      write: false,
      build: () => ({
        operationName,
        query: GET_COMPONENT,
        variables: {
          id: input.args.id,
          customFields: flags.customFields ?? true,
          links: flags.relatedLinks ?? true,
          relationships: flags.relatedComponents ?? false,
        },
      }),
      shape(data) {
        const found = resolved(operationName, compassRoot(operationName, data).component);
        const compact: Record<string, unknown> = { ...compactComponent(found) };
        if (Array.isArray(found.customFields)) {
          compact.customFields = found.customFields.filter(isRecord).map((field) => {
            const definition = isRecord(field.definition)
              ? compactDefinition(field.definition)
              : undefined;
            return {
              id: definition?.id,
              name: definition?.name,
              type: definition?.type,
              value: customFieldValue(field),
            };
          });
        }
        if (Array.isArray(found.links)) {
          compact.links = found.links.filter(isRecord).map((link) => ({
            id: stringOf(link.id),
            type: stringOf(link.type),
            name: stringOf(link.name),
            url: stringOf(link.url),
          }));
        }
        if (flags.relatedComponents === true) {
          compact.relationships = compactRelationships(operationName, found);
        }
        return compact;
      },
    });
  },
});

// ---------------------------------------------------------------------------
// compass.fields
// ---------------------------------------------------------------------------

const fields = defineCommand({
  name: "compass.fields",
  summary: "List Compass custom field definitions",
  mcpTools: ["getCompassCustomFieldDefinitions"],
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl compass fields"],
  run(ctx) {
    const operationName = "CompassCustomFieldDefinitions";
    return execute(ctx, {
      write: false,
      build: (cloudId) => ({
        operationName,
        query: FIELD_DEFINITIONS,
        variables: { query: { cloudId } },
      }),
      shape(data) {
        const result = resolved(
          operationName,
          compassRoot(operationName, data).customFieldDefinitions,
        );
        const nodes = Array.isArray(result.nodes) ? result.nodes.filter(isRecord) : [];
        return { items: nodes.map(compactDefinition) };
      },
    });
  },
});

// ---------------------------------------------------------------------------
// compass.field-create
// ---------------------------------------------------------------------------

const FieldInput = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    type: Type.Union([
      Type.Literal("TEXT"),
      Type.Literal("NUMBER"),
      Type.Literal("BOOLEAN"),
      Type.Literal("USER"),
    ]),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const DEFINITION_INPUT_KEYS = {
  TEXT: "textFieldDefinition",
  NUMBER: "numberFieldDefinition",
  BOOLEAN: "booleanFieldDefinition",
  USER: "userFieldDefinition",
} as const;

const fieldCreate = defineCommand({
  name: "compass.field-create",
  summary: "Create a Compass custom field definition",
  mcpTools: ["createCompassCustomFieldDefinition"],
  args: [],
  flags: Type.Object({
    inputFile: Type.String({
      description:
        'JSON file: {"name": "...", "type": "TEXT|NUMBER|BOOLEAN|USER", "description"?: "..."}',
    }),
  }),
  sideEffects: "write",
  examples: ["atl compass field-create --input-file field.json --plan"],
  async run(ctx, input) {
    const path = input.flags.inputFile;
    const raw = await readJsonObject(path, "--input-file");
    if (raw.type === "DATE") {
      throw inputError(
        "unsupported_field_type",
        `--input-file ${path}: Compass GraphQL has no DATE custom field definition`,
        "Supported types: TEXT, NUMBER, BOOLEAN, USER.",
      );
    }
    if ("isRequired" in raw) {
      throw inputError(
        "unsupported_field_option",
        `--input-file ${path}: Compass GraphQL custom field definitions have no isRequired option`,
        "Remove isRequired from the file.",
      );
    }
    if (!check(FieldInput, raw)) {
      throw inputError(
        "invalid_field_input",
        `--input-file ${path} must be {"name": string, "type": "TEXT"|"NUMBER"|"BOOLEAN"|"USER", "description"?: string}`,
      );
    }
    const { type, ...definition } = raw;
    const operationName = "CompassCreateCustomFieldDefinition";
    return execute(ctx, {
      write: true,
      build: (cloudId) => ({
        operationName,
        query: CREATE_FIELD_DEFINITION,
        variables: { input: { [DEFINITION_INPUT_KEYS[type]]: { cloudId, ...definition } } },
      }),
      shape(data) {
        const payload = mutationPayload(operationName, data, "createCustomFieldDefinition");
        return isRecord(payload.customFieldDefinition)
          ? compactDefinition(payload.customFieldDefinition)
          : null;
      },
    });
  },
});

// ---------------------------------------------------------------------------
// compass.create
// ---------------------------------------------------------------------------

const create = defineCommand({
  name: "compass.create",
  summary: "Create a Compass component",
  mcpTools: ["createCompassComponent"],
  args: [],
  flags: Type.Object({
    name: Type.String({ description: "Component name" }),
    typeId: Type.String({ description: "Component type id, e.g. SERVICE" }),
    description: Type.Optional(Type.String({ description: "Component description" })),
    ownerId: Type.Optional(Type.String({ description: "Owner team id" })),
    label: Type.Optional(Type.Array(Type.String(), { description: "Label; repeatable" })),
  }),
  sideEffects: "write",
  examples: ["atl compass create --name payments-api --type-id SERVICE --label backend --plan"],
  run(ctx, input) {
    const { flags } = input;
    const operationName = "CompassCreateComponent";
    return execute(ctx, {
      write: true,
      build: (cloudId) => ({
        operationName,
        query: CREATE_COMPONENT,
        variables: {
          cloudId,
          input: {
            name: flags.name,
            typeId: flags.typeId,
            ...(flags.description === undefined ? {} : { description: flags.description }),
            ...(flags.ownerId === undefined ? {} : { ownerId: flags.ownerId }),
            ...(flags.label === undefined ? {} : { labels: flags.label }),
          },
        },
      }),
      shape(data) {
        const payload = mutationPayload(operationName, data, "createComponent");
        return isRecord(payload.componentDetails)
          ? compactComponent(payload.componentDetails)
          : null;
      },
    });
  },
});

// ---------------------------------------------------------------------------
// compass.relate
// ---------------------------------------------------------------------------

const relate = defineCommand({
  name: "compass.relate",
  summary: "Create a relationship between two Compass components",
  mcpTools: ["createCompassComponentRelationship"],
  args: [
    { name: "from", description: "Source component ARI", required: true },
    { name: "to", description: "Target component ARI", required: true },
  ],
  flags: Type.Object({
    type: Type.Union([Type.Literal("DEPENDS_ON"), Type.Literal("DEPENDENCY_OF")], {
      description:
        "Relationship type: <from> DEPENDS_ON <to>, or <from> DEPENDENCY_OF <to> (stored as <to> DEPENDS_ON <from>)",
    }),
  }),
  sideEffects: "write",
  examples: ["atl compass relate <from-ari> <to-ari> --type DEPENDS_ON --plan"],
  run(ctx, input) {
    const { from, to } = input.args;
    const [startNodeId, endNodeId] = input.flags.type === "DEPENDS_ON" ? [from, to] : [to, from];
    const operationName = "CompassCreateRelationship";
    return execute(ctx, {
      write: true,
      build: () => ({
        operationName,
        query: CREATE_RELATIONSHIP,
        variables: { input: { relationshipType: "DEPENDS_ON", startNodeId, endNodeId } },
      }),
      shape(data) {
        const payload = mutationPayload(operationName, data, "createRelationship");
        return isRecord(payload.createdCompassRelationship)
          ? compactRelationship(payload.createdCompassRelationship)
          : null;
      },
    });
  },
});

export const compassCommands: readonly CommandSpec[] = [
  components,
  component,
  fields,
  fieldCreate,
  create,
  relate,
];
