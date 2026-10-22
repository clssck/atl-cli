/**
 * Minimal JSON Schema builders for command flags and API response shapes. Each builder returns the
 * plain JSON Schema object itself: no hidden keys, so a schema serializes exactly as written.
 * `Static<S>` recovers the TypeScript type through a phantom property that exists only in the
 * types. `Type.Optional` returns a copy registered in a private set; `Type.Object` reads that
 * set to build `required`. Validate with `check` from `./validate.ts`.
 */

declare const staticType: unique symbol;
declare const optionalMark: unique symbol;

interface Annotations {
  description?: string;
  title?: string;
  default?: unknown;
}

export interface TSchema<T = unknown> extends Annotations {
  /** Type-level only; never present at runtime. */
  readonly [staticType]?: T;
}

/** Infers the TypeScript type that a schema accepts. */
export type Static<S extends TSchema> = S extends { readonly [staticType]?: infer T } ? T : never;

export type TOptional<S extends TSchema> = S & { readonly [optionalMark]: true };

export type TProperties = Record<string, TSchema>;

type OptionalKeys<P extends TProperties> = {
  [K in keyof P]: P[K] extends { readonly [optionalMark]: true } ? K : never;
}[keyof P];

type Flatten<T> = { [K in keyof T]: T[K] } & {};

type ObjectStatic<P extends TProperties> = Flatten<
  { [K in Exclude<keyof P, OptionalKeys<P>>]: Static<P[K]> } & {
    [K in OptionalKeys<P>]?: Static<P[K]>;
  }
>;

export interface TObject<P extends TProperties = TProperties> extends TSchema<ObjectStatic<P>> {
  type: "object";
  /** Keys of the non-optional properties; absent when there are none. */
  required?: string[];
  properties: P;
  additionalProperties?: boolean;
}

export interface TArray<S extends TSchema = TSchema> extends TSchema<Static<S>[]> {
  type: "array";
  items: S;
}

export interface TUnion<S extends readonly TSchema[] = readonly TSchema[]> extends TSchema<
  Static<S[number]>
> {
  anyOf: S;
}

export interface TLiteral<
  T extends string | number | boolean = string | number | boolean,
> extends TSchema<T> {
  type: "string" | "number" | "boolean";
  const: T;
}

export interface TRecord<V extends TSchema = TSchema> extends TSchema<Record<string, Static<V>>> {
  type: "object";
  patternProperties: Record<string, V>;
}

export interface TString extends TSchema<string> {
  type: "string";
}
export interface TNumber extends TSchema<number> {
  type: "number";
}
export interface TInteger extends TSchema<number> {
  type: "integer";
}
export interface TBoolean extends TSchema<boolean> {
  type: "boolean";
}
export interface TNull extends TSchema<null> {
  type: "null";
}
export type TUnknown = TSchema;

export interface StringOptions extends Annotations {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
}
export interface NumberOptions extends Annotations {
  minimum?: number;
  maximum?: number;
}
export interface ArrayOptions extends Annotations {
  minItems?: number;
  maxItems?: number;
}
export interface ObjectOptions extends Annotations {
  additionalProperties?: boolean;
}

/** Properties registered through `Type.Optional`; `Type.Object` leaves them out of `required`. */
const optionalSchemas = new WeakSet<object>();

const STRING_KEY = "^.*$";

export const Type = {
  String: (options?: StringOptions): TString => ({ type: "string", ...options }),
  Number: (options?: NumberOptions): TNumber => ({ type: "number", ...options }),
  Integer: (options?: NumberOptions): TInteger => ({ type: "integer", ...options }),
  Boolean: (options?: Annotations): TBoolean => ({ type: "boolean", ...options }),
  Null: (options?: Annotations): TNull => ({ type: "null", ...options }),
  Unknown: (options?: Annotations): TUnknown => ({ ...options }),

  Literal: <const T extends string | number | boolean>(
    value: T,
    options?: Annotations,
  ): TLiteral<T> => ({
    type: typeof value === "string" ? "string" : typeof value === "number" ? "number" : "boolean",
    const: value,
    ...options,
  }),

  Array: <S extends TSchema>(items: S, options?: ArrayOptions): TArray<S> => ({
    type: "array",
    items,
    ...options,
  }),

  Union: <const S extends readonly TSchema[]>(anyOf: S, options?: Annotations): TUnion<S> => ({
    anyOf,
    ...options,
  }),

  /** String-keyed map: every property value must match `value`. */
  Record: <V extends TSchema>(_key: TString, value: V): TRecord<V> => ({
    type: "object",
    patternProperties: { [STRING_KEY]: value },
  }),

  Object: <P extends TProperties>(properties: P, options?: ObjectOptions): TObject<P> => {
    const required = Object.keys(properties).filter((key) => {
      const property = properties[key];
      return property === undefined || !optionalSchemas.has(property);
    });
    return {
      type: "object",
      ...(required.length > 0 ? { required } : {}),
      properties,
      ...options,
    };
  },

  /** Marks an object property as not required. Returns a copy so a shared schema stays required elsewhere. */
  Optional: <S extends TSchema>(schema: S): TOptional<S> => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the marker is type-only; the copy is tracked in optionalSchemas
    const copy = { ...schema } as TOptional<S>;
    optionalSchemas.add(copy);
    return copy;
  },
};
