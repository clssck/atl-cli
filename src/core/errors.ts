/**
 * Error contract shared by every module. Exit codes:
 * 0 ok, 1 input/config, 2 api/internal, 3 transient (429/5xx/timeout/409), 4 failed assertion.
 */
export type ErrorCategory =
  | "input"
  | "config"
  | "auth"
  | "api"
  | "internal"
  | "transient"
  | "assertion";

export const EXIT_CODES: Record<ErrorCategory, 1 | 2 | 3 | 4> = {
  input: 1,
  config: 1,
  auth: 1,
  api: 2,
  internal: 2,
  transient: 3,
  assertion: 4,
};

/** A follow-up command as argv, e.g. ["atl", "auth", "login"]. */
export type NextCommand = readonly string[];

export interface AtlErrorOptions {
  /** Stable machine code, snake_case, e.g. "not_logged_in", "http_404". */
  code: string;
  category: ErrorCategory;
  hint?: string;
  next?: readonly NextCommand[];
  /** HTTP status when the error came from an API response. */
  status?: number;
  cause?: unknown;
}

export class AtlError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly hint: string | undefined;
  readonly next: readonly NextCommand[];
  readonly status: number | undefined;

  constructor(message: string, options: AtlErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AtlError";
    this.code = options.code;
    this.category = options.category;
    this.hint = options.hint;
    this.next = options.next ?? [];
    this.status = options.status;
  }

  get exitCode(): number {
    return EXIT_CODES[this.category];
  }

  /** JSONL diagnostic written to stderr. Never contains credentials. */
  toDiagnostic(): Record<string, unknown> {
    return {
      type: "error",
      code: this.code,
      category: this.category,
      exitCode: this.exitCode,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.next.length === 0 ? {} : { next: this.next }),
    };
  }
}

/** Normalize any thrown value into an AtlError (unknown errors are internal). */
export function toAtlError(error: unknown): AtlError {
  if (error instanceof AtlError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AtlError(message, { code: "internal_error", category: "internal", cause: error });
}
