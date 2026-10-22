import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { defineCommand, type CommandSpec } from "../core/cli.ts";
import { AtlError } from "../core/errors.ts";
import { isRecord } from "../core/guards.ts";
import { openSession } from "../core/session.ts";
import { Type } from "../core/schema.ts";
import { shortTs } from "./common.ts";
import { ISSUE_ARG, issueSession, jiraDeps } from "./jira.ts";
import {
  applyArgv,
  applyArgvFor,
  isPlan,
  planOf,
  planOrSend,
  requireYes,
  YES_FLAG,
} from "./write.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

interface JiraAttachment {
  id: string;
  filename?: string;
  size?: number;
  mimeType?: string;
  created?: string;
  author?: { displayName?: string };
}

function compactAttachment(attachment: JiraAttachment) {
  return {
    id: attachment.id,
    filename: attachment.filename,
    size: attachment.size,
    mimeType: attachment.mimeType,
    author: attachment.author?.displayName,
    created: shortTs(attachment.created),
  };
}

function isAttachment(value: unknown): value is JiraAttachment {
  return isRecord(value) && typeof value.id === "string";
}

const ATTACHMENT_ID_ARG = {
  name: "id",
  description: "Attachment id (see `atl issue attachments <issue>`)",
  required: true,
};

// ---------------------------------------------------------------------------
// issue.attachments
// ---------------------------------------------------------------------------

const issueAttachments = defineCommand({
  name: "issue.attachments",
  summary: "List an issue's attachments (id, filename, size, mimeType, author, created)",
  args: [ISSUE_ARG],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl issue attachments ABC-123"],
  async run(ctx, input) {
    const { session, key } = await issueSession(ctx, input.args.issue ?? "");
    const issue = await session.http.request<{ fields?: { attachment?: JiraAttachment[] } }>({
      method: "GET",
      url: session.jiraUrl(`/rest/api/3/issue/${key}`, { fields: "attachment" }),
    });
    const attachments = issue.fields?.attachment ?? [];
    if (ctx.full) {
      return { items: attachments, nextCursor: null };
    }
    return { items: attachments.map(compactAttachment) };
  },
});

// ---------------------------------------------------------------------------
// issue.attachment.download
// ---------------------------------------------------------------------------

/** The attachment's own name, stripped of any directory part a hostile filename could carry. */
function safeFilename(filename: string | undefined, id: string): string {
  const name = basename((filename ?? "").replaceAll("\\", "/"));
  return name === "" || name === "." || name === ".." ? `attachment-${id}` : name;
}

const issueAttachmentDownload = defineCommand({
  name: "issue.attachment.download",
  summary:
    "Download an attachment to a file (never overwrites without --force); prints {path, bytes, mimeType}",
  mcpTools: ["downloadJiraIssueAttachment"],
  args: [ATTACHMENT_ID_ARG],
  flags: Type.Object({
    output: Type.Optional(
      Type.String({
        description:
          "File path, or an existing directory to save into (default: the attachment's filename in the current directory)",
      }),
    ),
    force: Type.Optional(Type.Boolean({ description: "Overwrite the target file if it exists" })),
  }),
  sideEffects: "local",
  examples: [
    "atl issue attachment download 10001",
    "atl issue attachment download 10001 --output /tmp/report.pdf",
  ],
  async run(ctx, input) {
    const id = input.args.id ?? "";
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const encoded = encodeURIComponent(id);
    const meta = await session.http.request<JiraAttachment>({
      method: "GET",
      url: session.jiraUrl(`/rest/api/3/attachment/${encoded}`),
    });
    const filename = safeFilename(meta.filename, id);
    const requested = input.flags.output;
    const isDirectory =
      requested !== undefined && (await stat(requested).catch(() => null))?.isDirectory();
    const path =
      requested === undefined
        ? filename
        : isDirectory === true
          ? join(requested, filename)
          : requested;

    const contentUrl = session.jiraUrl(`/rest/api/3/attachment/content/${encoded}`);
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (ctx.plan) {
      return {
        ...planOf({ method: "GET", url: contentUrl }, [applyArgv(ctx.argv)]),
        path,
        exists,
      };
    }
    if (exists && input.flags.force !== true) {
      throw new AtlError(`${path} already exists`, {
        code: "file_exists",
        category: "input",
        hint: "Pass --force to overwrite it, or choose another file with --output.",
        next: [["atl", "issue", "attachment", "download", id, "--output", `${id}-${filename}`]],
      });
    }
    const response = await session.http.requestRaw({ method: "GET", url: contentUrl });
    let bytes: number;
    try {
      bytes = await Bun.write(path, response);
    } catch (cause) {
      throw new AtlError(
        `Cannot write ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          code: "output_write_failed",
          category: "input",
          hint: "Check that the path is writable.",
          cause,
        },
      );
    }
    return {
      path,
      bytes,
      mimeType: meta.mimeType ?? response.headers.get("content-type") ?? undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// issue.attachment.add
// ---------------------------------------------------------------------------

/** The file as an in-memory `File` named after its basename (a path-backed Blob would send the full path). */
async function readUpload(path: string): Promise<File> {
  const source = Bun.file(path);
  const info = await stat(path).catch((cause: unknown) => {
    throw new AtlError(`Cannot read ${path}`, {
      code: "input_file_unreadable",
      category: "input",
      cause,
    });
  });
  if (!info.isFile()) {
    throw new AtlError(`${path} is not a regular file`, {
      code: "input_file_unreadable",
      category: "input",
    });
  }
  // Jira stores `"` as `_`, whereas multipart encoding would turn it into a literal `%22`.
  const name = basename(path).replaceAll(/["\r\n]/g, "_");
  return new File([await source.arrayBuffer()], name, { type: source.type });
}

const issueAttachmentAdd = defineCommand({
  name: "issue.attachment.add",
  summary: "Attach one or more local files to an issue (multipart upload)",
  mcpTools: ["uploadAttachmentToJiraIssue"],
  args: [
    ISSUE_ARG,
    { name: "file", description: "File to attach", required: true, variadic: true },
  ],
  flags: Type.Object({}),
  sideEffects: "write",
  examples: [
    "atl issue attachment add ABC-123 ./screenshot.png",
    "atl issue attachment add ABC-123 report.pdf notes.txt --plan",
  ],
  async run(ctx, input) {
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    const uploads = await Promise.all(input.rest.map(readUpload));
    const url = session.jiraUrl(`/rest/api/3/issue/${key}/attachments`);

    if (ctx.plan) {
      return planOf(
        {
          method: "POST",
          url,
          body: { files: uploads.map((u) => ({ filename: u.name, bytes: u.size })) },
        },
        [applyArgv(ctx.argv)],
      );
    }
    const form = new FormData();
    for (const file of uploads) {
      form.append("file", file);
    }
    const response = await session.http.requestRaw({
      method: "POST",
      url,
      accept: "application/json",
      headers: { "X-Atlassian-Token": "no-check" },
      body: form,
    });
    const created: unknown = await response.json();
    const attachments = Array.isArray(created) ? created.filter(isAttachment) : [];
    if (ctx.full) {
      return created;
    }
    return {
      issue: rawKey,
      items: attachments.map(compactAttachment),
      next: [["atl", "issue", "attachments", rawKey]],
    };
  },
});

// ---------------------------------------------------------------------------
// issue.attachment.delete
// ---------------------------------------------------------------------------

const issueAttachmentDelete = defineCommand({
  name: "issue.attachment.delete",
  summary: "Delete an attachment (irreversible; needs --yes)",
  mcpTools: ["deleteJiraIssueAttachment"],
  args: [ATTACHMENT_ID_ARG],
  flags: Type.Object({ yes: YES_FLAG }),
  sideEffects: "write",
  examples: ["atl issue attachment delete 10001 --plan", "atl issue attachment delete 10001 --yes"],
  async run(ctx, input) {
    const id = input.args.id ?? "";
    requireYes(ctx, input.flags.yes, `DELETE attachment ${id}`);
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const sent = await planOrSend<undefined>(
      ctx,
      session.http,
      {
        method: "DELETE",
        url: session.jiraUrl(`/rest/api/3/attachment/${encodeURIComponent(id)}`),
      },
      [applyArgvFor(ctx, true)],
    );
    return isPlan(sent) ? sent : { deleted: id };
  },
});

export const jiraAttachmentCommands: readonly CommandSpec[] = [
  issueAttachments,
  issueAttachmentDownload,
  issueAttachmentAdd,
  issueAttachmentDelete,
];
