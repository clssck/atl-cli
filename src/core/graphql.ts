import { AtlError } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { mapHttpError, type HttpClient } from "./http.ts";
import { API_ORIGIN } from "./session.ts";

export const GRAPHQL_URL = `${API_ORIGIN}/graphql`;

export interface GraphqlRequest {
  /** Required by the gateway; anonymous operations are rejected in the future. */
  operationName: string;
  query: string;
  variables?: Readonly<Record<string, unknown>>;
  /** Values for the `X-ExperimentalApi` header, for fields the gateway marks experimental. */
  experimental?: readonly string[];
}

interface GraphqlErrorEntry {
  message: string;
  statusCode: number | undefined;
  classification: string | undefined;
  path: readonly (string | number)[];
}

function readErrors(value: unknown): GraphqlErrorEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((entry) => {
    const extensions = isRecord(entry.extensions) ? entry.extensions : {};
    return {
      message: typeof entry.message === "string" ? entry.message : "GraphQL error",
      statusCode: typeof extensions.statusCode === "number" ? extensions.statusCode : undefined,
      classification:
        typeof extensions.classification === "string" ? extensions.classification : undefined,
      path: Array.isArray(entry.path)
        ? entry.path.filter(
            (segment): segment is string | number =>
              typeof segment === "string" || typeof segment === "number",
          )
        : [],
    };
  });
}

/** True when the error's path resolves to null/absent in `data` (the field produced nothing). */
function nulledByError(data: Record<string, unknown>, path: readonly (string | number)[]): boolean {
  if (path.length === 0) {
    return false;
  }
  let node: unknown = data;
  for (const segment of path) {
    if (Array.isArray(node) && typeof segment === "number") {
      node = node[segment];
    } else if (isRecord(node) && typeof segment === "string") {
      node = node[segment];
    } else {
      return true;
    }
    if (node === null || node === undefined) {
      return true;
    }
  }
  return false;
}

function toError(operationName: string, errors: readonly GraphqlErrorEntry[]): AtlError {
  const message = errors.map((error) => error.message).join("; ") || "no data";
  const status = errors.find((error) => error.statusCode !== undefined)?.statusCode;
  if (status !== undefined) {
    return mapHttpError(
      "POST",
      `${GRAPHQL_URL}#${operationName}`,
      status,
      JSON.stringify({ message }),
    );
  }
  return new AtlError(`GraphQL ${operationName} failed: ${message}`, {
    code: "graphql_error",
    category: "api",
  });
}

/**
 * POST one operation to the Atlassian GraphQL gateway with the CLI's token. Returns `data`.
 * Throws an AtlError classified by the gateway's `statusCode` (same mapping as REST) when there is
 * no usable data or when an error nulled the field it points at (e.g. `{compass: {component:
 * null}}` with a 403 on that path). Errors that came alongside real data are `partialErrors`.
 */
export async function graphql(
  http: HttpClient,
  request: GraphqlRequest,
): Promise<{ data: Record<string, unknown>; partialErrors: string[] }> {
  const body = await http.request({
    method: "POST",
    url: GRAPHQL_URL,
    body: {
      operationName: request.operationName,
      query: request.query,
      variables: request.variables ?? {},
    },
    ...(request.experimental === undefined || request.experimental.length === 0
      ? {}
      : { headers: { "X-ExperimentalApi": request.experimental.join(",") } }),
  });
  if (!isRecord(body)) {
    throw new AtlError(`GraphQL ${request.operationName} returned an unexpected body`, {
      code: "unexpected_response",
      category: "api",
    });
  }
  const errors = readErrors(body.errors);
  const data = isRecord(body.data) ? body.data : undefined;
  const hasData = data !== undefined && Object.values(data).some((value) => value !== null);
  if (!hasData) {
    throw toError(request.operationName, errors);
  }
  const fatal = errors.filter((error) => nulledByError(data, error.path));
  if (fatal.length > 0) {
    throw toError(request.operationName, fatal);
  }
  return { data, partialErrors: errors.map((error) => error.message) };
}
