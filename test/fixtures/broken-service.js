/**
 * A deliberately broken implementation of the contract, for proving that the
 * conformance suite fails, and says why, against a service that gets things
 * wrong. Each fault is one a real backend could plausibly ship:
 *
 *   - no X-Request-Id, and errors that are not the contract's error body;
 *   - CORS with `*` and credentials, no exposed headers, a preflight without PATCH or DELETE;
 *   - /v2/ answered as if it were /v1/;
 *   - a malformed body answered with a 500;
 *   - comments served for every page, pending ones and emails included;
 *   - no Idempotency-Key handling: a retried reaction counts twice;
 *   - no validation: a short correction report is accepted;
 *   - the contact form echoes the sender's email;
 *   - no rate limit at all.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export function createBrokenServer() {
  const comments = [];
  const reactions = {};

  return createServer(async (message, reply) => {
    const url = new URL(message.url, "http://broken.invalid");
    const chunks = [];
    for await (const chunk of message) {
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Credentials": "true",
      "Content-Type": "application/json"
    };
    const send = (status, body) => {
      reply.writeHead(status, headers);
      reply.end(body === undefined ? "" : JSON.stringify(body));
    };

    if (message.method === "OPTIONS") {
      reply.writeHead(204, { ...headers, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" });
      reply.end();
      return;
    }
    const path = url.pathname.replace(/^\/v\d+/, "");
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        send(500, { message: "Internal error" });
        return;
      }
    }

    if (path === "/capabilities" && message.method === "GET") {
      send(200, { api_version: "1", features: { comments: true, reactions: true, corrections: true, contact: true } });
    } else if (path === "/comments" && message.method === "GET") {
      send(200, { comments });
    } else if (path === "/comments" && message.method === "POST") {
      const comment = { id: randomUUID(), parent_id: body.parent_id ?? null, author: body.author, body: body.body, created_at: new Date().toISOString() };
      comments.push(comment);
      send(200, { id: comment.id });
    } else if (path === "/reactions" && message.method === "GET") {
      send(200, { counts: reactions[url.searchParams.get("path")] || {} });
    } else if (path === "/reactions" && message.method === "POST") {
      const counts = (reactions[body.path] ||= {});
      counts[body.reaction] = (counts[body.reaction] || 0) + 1;
      send(201, { counts, reaction: body.reaction });
    } else if (path === "/corrections" && message.method === "POST") {
      send(202, { status: "received", id: randomUUID() });
    } else if (path === "/contact" && message.method === "POST") {
      send(200, { status: "received", email: body.email });
    } else {
      reply.writeHead(404, { ...headers, "Content-Type": "text/plain" });
      reply.end("Not found");
    }
  });
}
