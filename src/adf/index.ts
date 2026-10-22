import { AtlError } from "../core/errors.ts";
import { markdownToAdf } from "./from-markdown.ts";
import { adfToMarkdown } from "./to-markdown.ts";
import { isAdfDocLike } from "./types.ts";
import type { AdfDoc } from "./types.ts";

export { adfToMarkdown, markdownToAdf };
export type { AdfDoc, AdfMark, AdfNode } from "./types.ts";

function adfParseError(message: string, cause?: unknown): AtlError {
  return new AtlError(message, {
    code: "adf_parse_error",
    category: "api",
    hint: "The API returned a body that is not a valid ADF document. Re-fetch with --format adf to inspect it.",
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Confluence v2 returns ADF as a JSON string in `body.atlas_doc_format.value`; Jira v3 returns the
 * object directly. Accept both and normalise to `{type:"doc", version:1, content}`.
 */
export function parseAdfBody(value: string | AdfDoc): AdfDoc {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw adfParseError("Failed to parse ADF body: invalid JSON", error);
    }
  }
  if (!isAdfDocLike(parsed)) {
    throw adfParseError('Failed to parse ADF body: expected an object with type "doc"');
  }
  return { type: "doc", version: 1, content: parsed.content ?? [] };
}
