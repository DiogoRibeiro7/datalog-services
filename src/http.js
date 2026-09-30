/**
 * The contract's error model and the JSON every answer is written in.
 *
 * A failure answers with the status the theme's client understands and the
 * body `{ error: { code, message, errors? }, request_id }`: `code` is the
 * feature's own, `message` is for the reader when the theme has nothing
 * better, and `errors` maps field names to messages on a 422.
 */

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code - The feature's error code, for the widget and the logs
   * @param {string} message - For the reader, when the theme has nothing better
   * @param {Object} [details]
   * @param {Object.<string, string>} [details.errors] - Field messages, on a 422
   * @param {Object.<string, string>} [details.headers] - Such as Retry-After or Allow
   */
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.errors = details.errors || null;
    this.headers = details.headers || {};
  }
}

/** A 422 naming the fields at fault. */
export function invalid(errors, message = "Some of what was sent needs a correction.") {
  return new HttpError(422, "invalid", message, { errors });
}

/**
 * What a handler returns: a status, a JSON body (or none, for a 204) and any
 * headers of its own.
 * @typedef {{ status: number, body?: *, headers?: Object.<string, string> }} Result
 */

/** @returns {Result} */
export function result(status, body, headers = {}) {
  return { status, body, headers };
}

export function errorBody(error, requestId) {
  const body = { error: { code: error.code, message: error.message } };
  if (error.errors) {
    body.error.errors = error.errors;
  }
  body.request_id = requestId;
  return body;
}

/**
 * The Response for a result. JSON always, never cached unless the handler
 * says so, and a 204 has no body at all.
 */
export function toResponse(outcome, headers) {
  const merged = new Headers(headers);
  for (const [name, value] of Object.entries(outcome.headers || {})) {
    if (name.toLowerCase() === "set-cookie") {
      for (const cookie of [].concat(value)) {
        merged.append("Set-Cookie", cookie);
      }
    } else {
      merged.set(name, value);
    }
  }
  if (!merged.has("Cache-Control")) {
    merged.set("Cache-Control", "no-store");
  }
  if (outcome.status === 204 || outcome.body === undefined) {
    return new Response(null, { status: outcome.status, headers: merged });
  }
  merged.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers: merged });
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * A write's JSON body, from its text. Anything but `application/json` is a
 * 415, more than 64 KB a 413, and text that is not a JSON object a 400. With
 * `optional`, an empty body reads as `{}`.
 * @param {Request} request
 * @param {string} text - The body, already read
 * @param {boolean} [optional]
 * @returns {Object}
 */
export function readJsonText(request, text, optional = false) {
  if (optional && text.trim() === "") {
    return {};
  }
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Send the request as application/json.");
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", "The request is too large.");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "invalid_json", "The request body must be a JSON object.");
  }
  return data;
}
