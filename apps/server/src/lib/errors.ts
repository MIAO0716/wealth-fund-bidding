import { ERROR_MESSAGES, type ErrorCode } from '@bidding/shared';

const STATUS: Partial<Record<ErrorCode, number>> = {
  SESSION_INVALID: 401,
  UNAUTHORIZED: 401,
  CREDENTIAL_INVALID: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CONTROL_VERSION_CONFLICT: 409,
  DRAFT_VERSION_CONFLICT: 409,
  INTERNAL: 500,
  READ_ONLY: 503,
  TOO_MANY_ATTEMPTS: 429,
};

/** 业务错误：返回统一错误码与中文提示 */
export class BizError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? ERROR_MESSAGES[code]);
    this.code = code;
    this.status = STATUS[code] ?? 422;
    this.details = details;
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export function bizError(code: ErrorCode, message?: string, details?: unknown): BizError {
  return new BizError(code, message, details);
}
