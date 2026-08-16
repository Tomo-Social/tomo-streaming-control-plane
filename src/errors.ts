export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}
