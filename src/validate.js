/**
 * Field checks for what readers send. Each check returns the cleaned value,
 * or records a message under the field's name and returns undefined; `done()`
 * throws the contract's 422 when anything was recorded, which the theme's
 * forms show next to the fields.
 *
 * Text is kept as text: trimmed, Unicode-normalized, stripped of control
 * characters (a line break survives where the field allows several lines) and
 * limited in length. It is never interpreted as HTML here, and the theme
 * renders it as text; anything else that reads the store must escape it.
 */

import { invalid } from "./http.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Control and invisible formatting characters are what these match.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_INLINE = /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g;

export class Fields {
  constructor(input) {
    this.input = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    this.errors = {};
  }

  fail(field, message) {
    if (!this.errors[field]) {
      this.errors[field] = message;
    }
    return undefined;
  }

  /**
   * @param {string} field
   * @param {Object} [rules] - `min`, `max`, `required`, `multiline`, `from` (the value, when not input[field])
   */
  text(field, rules = {}) {
    const raw = "from" in rules ? rules.from : this.input[field];
    if (raw === undefined || raw === null || raw === "") {
      return rules.required ? this.fail(field, "Required.") : undefined;
    }
    if (typeof raw !== "string") {
      return this.fail(field, "Must be text.");
    }
    const cleaned = raw.normalize("NFC").replace(rules.multiline ? CONTROL : CONTROL_INLINE, rules.multiline ? "" : " ").trim();
    if (cleaned === "") {
      return rules.required ? this.fail(field, "Required.") : undefined;
    }
    const length = [...cleaned].length;
    if (rules.min && length < rules.min) {
      return this.fail(field, `At least ${rules.min} characters.`);
    }
    if (rules.max && length > rules.max) {
      return this.fail(field, `At most ${rules.max} characters.`);
    }
    return cleaned;
  }

  email(field, rules = {}) {
    const value = this.text(field, { ...rules, max: 254 });
    if (value !== undefined && !EMAIL.test(value)) {
      return this.fail(field, "Enter an email address.");
    }
    return value?.toLowerCase();
  }

  /** An http or https address. */
  url(field, rules = {}) {
    const value = this.text(field, { ...rules, max: rules.max || 2000 });
    if (value === undefined) {
      return undefined;
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return this.fail(field, "Enter a web address starting with https://.");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return this.fail(field, "Enter a web address starting with https://.");
    }
    return parsed.href;
  }

  /** A path on the site: `/2024/04/05/post/`. */
  path(field, rules = {}) {
    const value = this.text(field, { ...rules, max: 500 });
    if (value !== undefined && (!value.startsWith("/") || value.startsWith("//") || /\s/.test(value))) {
      return this.fail(field, "Must be a path on the site, starting with /.");
    }
    return value;
  }

  oneOf(field, allowed, rules = {}) {
    const value = this.text(field, { ...rules, max: 100 });
    if (value !== undefined && !allowed.includes(value)) {
      return this.fail(field, `Must be one of: ${allowed.join(", ")}.`);
    }
    return value;
  }

  /** A list of strings, each one of `allowed`. */
  subset(field, allowed, rules = {}) {
    const raw = this.input[field];
    if (raw === undefined || raw === null) {
      return rules.required ? this.fail(field, "Required.") : undefined;
    }
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
      return this.fail(field, "Must be a list.");
    }
    const unknown = raw.filter((entry) => !allowed.includes(entry));
    if (unknown.length > 0) {
      return this.fail(field, `Not offered: ${unknown.join(", ")}.`);
    }
    if (rules.nonEmpty && raw.length === 0) {
      return this.fail(field, "Choose at least one.");
    }
    return [...new Set(raw)];
  }

  /** Throws the 422 when any field failed. */
  done() {
    if (Object.keys(this.errors).length > 0) {
      throw invalid(this.errors);
    }
  }
}

/** A path on the site, from a query string parameter, or a 422 naming it. */
export function requirePath(query, name = "path") {
  const fields = new Fields({ [name]: query.get(name) ?? undefined });
  const value = fields.path(name, { required: true });
  fields.done();
  return value;
}

/** How many web addresses a text holds, for the link limit on comments. */
export function countLinks(text) {
  return (String(text).match(/\bhttps?:\/\/|\bwww\./gi) || []).length;
}
