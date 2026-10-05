import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORGEJO_TOKEN, FORGEJO_URL } from "./env";
import type { Git } from "./types";

const root = join(tmpdir(), "reviewer");
const locks = new Map<string, Promise<unknown>>();

// token goes in a header via env, so it never lands in argv or the mirror's config
const env = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`${FORGEJO_TOKEN}:x-oauth-basic`)}`,
};

async function run(...args: string[]) {
  const start = Date.now();
  const proc = Bun.spawn(["git", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  console.log(`git ${args.join(" ")}: exit ${code} ${Date.now() - start}ms`);
  if (code) throw new Error(`git ${args.join(" ")} exited ${code}: ${err}`);
  return out;
}

// runs on one mirror don't overlap, or concurrent fetches fight over ref locks
function locked<T>(mirror: string, fn: () => Promise<T>) {
  const next = (locks.get(mirror) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(mirror, next);
  return next;
}

export const git: Git = {
  checkout({ owner, repo }, base, head, since) {
    const mirror = join(root, "mirrors", owner, `${repo}.git`);
    return locked(mirror, async () => {
      if (existsSync(mirror)) await run("-C", mirror, "fetch", "--prune", "origin");
      else await run("clone", "--mirror", `${FORGEJO_URL}/${owner}/${repo}.git`, mirror);
      await run("-C", mirror, "worktree", "prune");
      // a force-push can drop since from head's history: fall back to a full review
      const from = since && (await run("-C", mirror, "merge-base", "--is-ancestor", since, head).then(() => since, () => ""));
      const diff = await run("-C", mirror, "diff", from ? `${from}..${head}` : `${base}...${head}`);
      const log = await run("-C", mirror, "log", `${from || base}..${head}`);
      const rules = await Promise.all(
        ["REVIEW.md", "AGENTS.md", "CLAUDE.md"].map((f) => run("-C", mirror, "show", `${base}:${f}`).then((t) => `### ${f}\n\n${t}`, () => "")),
      );
      const dir = join(root, "worktrees", randomUUID());
      await run("-C", mirror, "worktree", "add", "--detach", dir, head);
      return { dir, diff, log, rules: rules.filter(Boolean).join("\n"), incremental: !!from };
    });
  },

  async remove({ dir }) {
    await rm(dir, { recursive: true, force: true });
  },
};
