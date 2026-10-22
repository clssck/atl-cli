/** Narrow to a plain JSON-like object (not null, not an array). Fields remain `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
