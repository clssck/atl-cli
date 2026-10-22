/** Atlassian Document Format (ADF) shapes shared by both converters. */
import { isRecord } from "../core/guards.ts";

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

/** True for any object that is an ADF root: `type: "doc"` with an optional `content` array. */
export function isAdfDocLike(value: unknown): value is { type: "doc"; content?: AdfNode[] } {
  return (
    isRecord(value) &&
    value.type === "doc" &&
    (value.content === undefined || Array.isArray(value.content))
  );
}
