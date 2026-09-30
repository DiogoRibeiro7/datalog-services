/**
 * The Worker build running locally in workerd through `wrangler dev --local`,
 * with a fresh D1 migrated from migrations/, for the scripts that exercise
 * the deployment target without deploying it. The database and the settings
 * file live in a temporary directory removed by `stop()`.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

function kill(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

/**
 * @param {Object.<string, string>} env - The Worker's settings, secrets included
 * @param {Object} [options] - `port`, and `origin` to probe capabilities with
 * @returns {Promise<{ base: string, stop: Function }>}
 */
export async function startWorker(env, options = {}) {
  const port = options.port || 8790;
  const work = await mkdtemp(join(tmpdir(), "datalog-worker-"));
  const envFile = join(work, "worker.env");
  const persist = join(work, "state");
  await writeFile(envFile, `${Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\n")}\n`);

  let dev = null;
  const stop = async () => {
    kill(dev);
    await rm(work, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const migrated = spawnSync(process.execPath, [WRANGLER, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], {
      cwd: ROOT,
      env: { ...process.env, CI: "true" },
      encoding: "utf8"
    });
    if (migrated.status !== 0) {
      throw new Error(`wrangler d1 migrations apply failed:\n${migrated.stdout}\n${migrated.stderr}`);
    }
    dev = spawn(process.execPath, [WRANGLER, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persist, "--env-file", envFile], {
      cwd: ROOT,
      env: { ...process.env, CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let output = "";
    dev.stdout.on("data", (chunk) => (output += chunk));
    dev.stderr.on("data", (chunk) => (output += chunk));

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const response = await fetch(`${base}/v1/capabilities`, { headers: options.origin ? { Origin: options.origin } : {} });
        if (response.ok) {
          return { base, stop };
        }
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline || dev.exitCode !== null) {
        throw new Error(`wrangler dev did not start:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    await stop();
    throw error;
  }
}
