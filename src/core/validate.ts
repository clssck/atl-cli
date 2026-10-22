import { isRecord } from "./guards.ts";
import type { Static, TSchema } from "./schema.ts";

/**
 * Runtime check for the JSON Schema that the `Type.*` builders in `./schema.ts` emit: `type`
 * (object, array, string, number, integer, boolean, null), `const`, `anyOf`, `properties` with
 * `required`, `patternProperties`, `additionalProperties`, `items`, and the min/max length, item
 * and value limits. Other keywords are ignored. Issue paths are JSON Pointers and messages follow
 * the usual JSON Schema validator wording ("must be string").
 */
export interface SchemaIssue {
  /** JSON Pointer of the failing value; "" is the root. */
  path: string;
  keyword: string;
  message: string;
  /** Every missing property, for keyword `required`. */
  missing?: string[];
}

export function check<S extends TSchema>(schema: S, value: unknown): value is Static<S> {
  return visit(schema, value, "") === undefined;
}

/** The first issue in property order, or undefined when the value matches. */
export function firstIssue(schema: TSchema, value: unknown): SchemaIssue | undefined {
  return visit(schema, value, "");
}

const patterns = new Map<string, RegExp>();

function pattern(source: string): RegExp {
  let regex = patterns.get(source);
  if (regex === undefined) {
    regex = new RegExp(source, "u");
    patterns.set(source, regex);
  }
  return regex;
}

function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function hasType(type: unknown, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function limit(
  path: string,
  keyword: string,
  bound: unknown,
  actual: number,
  message: string,
): SchemaIssue | undefined {
  if (typeof bound !== "number") {
    return undefined;
  }
  const below = keyword.startsWith("min") ? actual < bound : actual > bound;
  return below ? { path, keyword, message: message.replace("{}", String(bound)) } : undefined;
}

function visit(schema: unknown, value: unknown, path: string): SchemaIssue | undefined {
  if (!isRecord(schema)) {
    return schema === false ? { path, keyword: "boolean", message: "schema is false" } : undefined;
  }
  if (!hasType(schema.type, value)) {
    return { path, keyword: "type", message: `must be ${String(schema.type)}` };
  }
  if ("const" in schema && value !== schema.const) {
    return { path, keyword: "const", message: "must be equal to constant" };
  }
  if (Array.isArray(schema.anyOf)) {
    let first: SchemaIssue | undefined;
    for (const branch of schema.anyOf) {
      const issue = visit(branch, value, path);
      if (issue === undefined) {
        return undefined;
      }
      first ??= issue;
    }
    return first ?? { path, keyword: "anyOf", message: "must match a schema in anyOf" };
  }
  if (typeof value === "string") {
    if (schema.minLength === undefined && schema.maxLength === undefined) {
      return undefined;
    }
    // String lengths count code points, not UTF-16 units.
    const length = Array.from(value).length;
    return (
      limit(
        path,
        "minLength",
        schema.minLength,
        length,
        "must not have fewer than {} characters",
      ) ??
      limit(path, "maxLength", schema.maxLength, length, "must not have more than {} characters")
    );
  }
  if (typeof value === "number") {
    return (
      limit(path, "minimum", schema.minimum, value, "must be >= {}") ??
      limit(path, "maximum", schema.maximum, value, "must be <= {}")
    );
  }
  if (Array.isArray(value)) {
    const issue =
      limit(path, "minItems", schema.minItems, value.length, "must not have fewer than {} items") ??
      limit(path, "maxItems", schema.maxItems, value.length, "must not have more than {} items");
    if (issue !== undefined || schema.items === undefined) {
      return issue;
    }
    for (const [index, item] of value.entries()) {
      const itemIssue = visit(schema.items, item, pointer(path, index));
      if (itemIssue !== undefined) {
        return itemIssue;
      }
    }
    return undefined;
  }
  return isRecord(value) ? visitObject(schema, value, path) : undefined;
}

function visitObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
): SchemaIssue | undefined {
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter(
    (key): key is string => typeof key === "string" && !Object.hasOwn(value, key),
  );
  if (missing.length > 0) {
    return {
      path,
      keyword: "required",
      message: `must have required properties ${missing.join(", ")}`,
      missing,
    };
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    const property = value[key];
    // An optional property may be present with the value `undefined`.
    if (property === undefined && !required.includes(key)) {
      continue;
    }
    if (Object.hasOwn(value, key)) {
      const issue = visit(propertySchema, property, pointer(path, key));
      if (issue !== undefined) {
        return issue;
      }
    }
  }
  const patternProperties = isRecord(schema.patternProperties)
    ? Object.entries(schema.patternProperties)
    : [];
  const additional = schema.additionalProperties;
  if (patternProperties.length === 0 && additional === undefined) {
    return undefined;
  }
  for (const [key, property] of Object.entries(value)) {
    let matched = Object.hasOwn(properties, key);
    for (const [source, propertySchema] of patternProperties) {
      if (pattern(source).test(key)) {
        matched = true;
        const issue = visit(propertySchema, property, pointer(path, key));
        if (issue !== undefined) {
          return issue;
        }
      }
    }
    if (!matched && additional !== undefined && additional !== true) {
      const issue = visit(additional, property, pointer(path, key));
      if (issue !== undefined) {
        return issue;
      }
    }
  }
  return undefined;
}
