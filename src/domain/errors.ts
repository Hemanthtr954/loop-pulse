/**
 * Application errors map 1:1 onto RFC 9457 problem documents. Anything that is not an
 * AppError is treated as an unexpected 500 and its message is never shown to clients.
 */
export interface FieldError {
  field: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail?: string,
    readonly extensions: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(detail ?? title);
  }

  static badRequest(detail: string, errors: FieldError[]): AppError {
    return new AppError(400, 'invalid-request', 'Invalid request', detail, { errors });
  }

  static unauthorized(): AppError {
    return new AppError(401, 'unauthorized', 'Unauthorized', 'A valid x-api-key header is required for this operation.');
  }

  static forbidden(detail: string): AppError {
    return new AppError(403, 'forbidden', 'Forbidden', detail);
  }

  static notFound(detail: string): AppError {
    return new AppError(404, 'not-found', 'Not found', detail);
  }

  static conflict(type: string, title: string, detail: string, extensions: Record<string, unknown> = {}, headers: Record<string, string> = {}): AppError {
    return new AppError(409, type, title, detail, extensions, headers);
  }

  static unprocessable(type: string, title: string, detail: string, extensions: Record<string, unknown> = {}): AppError {
    return new AppError(422, type, title, detail, extensions);
  }
}
