/**
 * Starts the reference service as a conformance run wants it, on PORT (8788
 * by default), for running conformance/cli.js against it by hand:
 *
 *   node test/fixtures/run-reference.js &
 *   node conformance/cli.js --base-url http://127.0.0.1:8788 --origin https://site.conformance.test --hooks-token conformance-hooks-token
 */

import { HOOKS_TOKEN, ORIGIN, createReferenceServer } from "./reference-server.js";

const port = Number(process.env.PORT || 8788);
const server = await createReferenceServer();
server.listen(port, "127.0.0.1", () => {
  console.log(`reference service on http://127.0.0.1:${port} (origin ${ORIGIN}, hooks token ${HOOKS_TOKEN})`);
});
