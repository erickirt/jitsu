/**
 * Run a workspace dev command behind a portless https://{app}-{branch}.jitsu.localhost host.
 *
 *   tsx run-app.ts <app> <cmd...>
 *
 * Example (from webapps/console):
 *   tsx run-app.ts console next dev
 *
 * Responsibilities:
 *   1. Load `.env` and `.env.local` from the repo root into process.env.
 *   2. Pick a slug — `<app>` plain on the repo's default branch, `<app>-<branch>`
 *      otherwise. Default branch comes from `git rev-parse origin/HEAD`.
 *   3. Pass `--no-branch` to suppress the suffix.
 *   4. Spawn portless via the SHIM_DIR trick (see SHIM_DIR comment below).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

/**
 * Scratch dir we run portless from. Why:
 *
 * Portless inspects its own `cwd` with `git worktree list --porcelain`. When
 * cwd is inside a non-default git worktree, it prepends `<branch>.` to the
 * slug — DOT separator, hardcoded in three places in node_modules/portless/
 * dist/cli.js, no flag or env var to disable on the `run` / `<name> <cmd>`
 * code paths (`--no-worktree` exists only for `portless get`).
 *
 * That collides with our dash convention (`console-feat.jitsu.localhost`):
 * portless would turn it into `feat.console-feat.jitsu.localhost`. To keep
 * dash style we launch portless with cwd pointed at a path that is not in any
 * git repo, so both `detectWorktreeViaCli` (git command) and
 * `detectWorktreeViaFilesystem` (parent-dir .git walk) return null.
 *
 * The user's actual command still needs to run at the workspace cwd, so we
 * wrap it as `bash -c "cd <workspace> && <cmd>"`.
 *
 * Alternatives considered:
 *   - Programmatic portless: the package's public API exposes RouteStore /
 *     createProxyServer but not the ~200 LOC `runApp` / `ensureProxyRunning`
 *     orchestration. Re-implementing means owning a parallel runner forever.
 *   - Forking portless: too heavy for one-line behaviour.
 */
const SHIM_DIR = path.join(os.tmpdir(), "jitsu-portless-shim");

function loadRepoEnv(): void {
  for (const f of [".env", ".env.local"]) {
    const p = path.join(repoRoot, f);
    try {
      // process.loadEnvFile is built-in (Node ≥21.7). Doesn't overwrite existing vars.
      // Cast: @types/node in the workspace catalog is v18 and lacks the type.
      (process as unknown as { loadEnvFile(path: string): void }).loadEnvFile(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

function gitOutput(args: string[]): string | null {
  const r = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim() || null;
}

function defaultBranch(): string | null {
  const ref = gitOutput(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  return ref ? ref.replace(/^origin\//, "") : null;
}

function currentBranch(): string | null {
  return gitOutput(["branch", "--show-current"]);
}

function sanitizeBranch(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const noBranch = argv.includes("--no-branch");
  const positional = argv.filter(a => a !== "--no-branch");
  const [appName, ...command] = positional;
  if (!appName || command.length === 0) {
    console.error("Usage: run-app <app> [--no-branch] <cmd...>");
    process.exit(2);
  }

  loadRepoEnv();

  let branch = "";
  let branchSource = "";
  if (!noBranch) {
    const current = currentBranch();
    if (current) {
      const def = defaultBranch();
      if (!def || current !== def) {
        const sanitized = sanitizeBranch(current);
        if (sanitized) {
          branch = sanitized;
          branchSource = def ? `git (default branch: ${def})` : "git";
        }
      }
    }
  }

  const slug = (branch ? `${appName}-${branch}.jitsu` : `${appName}.jitsu`).toLowerCase();
  mkdirSync(SHIM_DIR, { recursive: true });

  // Capture the actual workspace cwd before we redirect portless to SHIM_DIR;
  // the spawned bash will cd back here so `next dev` finds package.json etc.
  const workspace = process.cwd();
  const innerCmd = `cd ${shellQuote(workspace)} && exec ${command.map(shellQuote).join(" ")}`;

  console.error(
    `[run-app] https://${slug}.localhost  (branch=${branch || "<none>"}${
      branchSource ? ` from ${branchSource}` : noBranch ? " — --no-branch" : ""
    })`
  );

  const child = spawn("portless", ["--name", slug, "bash", "-c", innerCmd], {
    cwd: SHIM_DIR,
    stdio: "inherit",
  });
  child.on("error", err => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("[run-app] `portless` binary not on PATH. Run via pnpm so node_modules/.bin is on PATH.");
      process.exit(127);
    }
    throw err;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal as NodeJS.Signals);
    else process.exit(code ?? 0);
  });
}

main();
