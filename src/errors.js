export class RelayError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.details = details;
  }
}

export function assertRelay(condition, code, message, details = undefined) {
  if (!condition) {
    throw new RelayError(code, message, details);
  }
}
