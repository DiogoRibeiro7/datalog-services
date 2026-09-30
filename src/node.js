/**
 * Serves the app from Node's http module, for local development, the tests
 * and the conformance runs: an IncomingMessage becomes a Request, the app's
 * Response goes back out. The client's address is the socket's, or the first
 * X-Forwarded-For entry when TRUST_PROXY says a proxy in front sets it.
 */

import { createServer } from "node:http";

const MAX_REQUEST_BYTES = 1024 * 1024;

async function readBody(message) {
  const chunks = [];
  let size = 0;
  for await (const chunk of message) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw Object.assign(new Error("request too large"), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function clientIp(message, trustProxy) {
  const forwarded = trustProxy ? String(message.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
  return forwarded || message.socket.remoteAddress || "unknown";
}

/**
 * @param {{ fetch: Function }} app
 * @param {Object} [options]
 * @param {boolean} [options.trustProxy]
 * @returns {import("node:http").Server}
 */
export function createNodeServer(app, options = {}) {
  const pending = new Set();
  const server = createServer(async (message, reply) => {
    try {
      const host = message.headers.host || "localhost";
      const url = new URL(message.url, `http://${host}`);
      const headers = new Headers();
      for (const [name, value] of Object.entries(message.headers)) {
        for (const entry of [].concat(value)) {
          headers.append(name, entry);
        }
      }
      const hasBody = !["GET", "HEAD"].includes(message.method);
      const request = new Request(url, {
        method: message.method,
        headers,
        body: hasBody ? await readBody(message) : undefined
      });
      const response = await app.fetch(request, {
        clientIp: clientIp(message, options.trustProxy),
        waitUntil(promise) {
          const tracked = Promise.resolve(promise).catch((error) => console.error(error)).finally(() => pending.delete(tracked));
          pending.add(tracked);
        }
      });
      const outgoing = {};
      response.headers.forEach((value, name) => {
        if (name !== "set-cookie") {
          outgoing[name] = value;
        }
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) {
        outgoing["set-cookie"] = cookies;
      }
      reply.writeHead(response.status, outgoing);
      reply.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      reply.writeHead(error.status || 500, { "content-type": "application/json" });
      reply.end(JSON.stringify({ error: { code: error.status === 413 ? "payload_too_large" : "internal", message: "The request could not be read." } }));
    }
  });
  /** Resolves once the background work of earlier requests has finished, for tests. */
  server.settled = () => Promise.all([...pending]);
  return server;
}
