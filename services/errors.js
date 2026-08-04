class ApiError extends Error {
  constructor(status, message, code, retryAfter) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

module.exports = { ApiError };
