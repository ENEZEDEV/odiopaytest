export class AppError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function requireThat(condition, status, code) {
  if (!condition) throw new AppError(status, code);
}
