import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./test-env";

test("repository rules use AGENTS.md and REVIEW.md from the PR base, not its head", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-git-test-"));
  const owner = `test-${randomUUID()}`;
  const repo = join(dir, owner, "repo.git");
  const git = async (...args: string[]) => {
    const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    if (code) throw new Error(err);
    return out.trim();
  };
  try {
    await Bun.write(join(repo, "AGENTS.md"), "base agent rules");
    await Bun.write(join(repo, "REVIEW.md"), "base review rules");
    await git("init");
    await git("add", ".");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
    const base = await git("rev-parse", "HEAD");
    await Bun.write(join(repo, "AGENTS.md"), "untrusted head rules");
    await Bun.write(join(repo, "REVIEW.md"), "untrusted head review rules");
    await git("add", ".");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "head");
    const head = await git("rev-parse", "HEAD");
    const script = `
      const { git } = await import(${JSON.stringify(new URL("../src/git.ts", import.meta.url).href)});
      const checkout = await git.checkout({owner: ${JSON.stringify(owner)}, repo: "repo", number: 1}, ${JSON.stringify(base)}, ${JSON.stringify(head)});
      try { console.log(JSON.stringify({rules: checkout.rules, headRules: await Bun.file(checkout.dir + "/AGENTS.md").text()})); }
      finally { await git.remove(checkout); }
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, FORGEJO_URL: `file://${dir}` }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    const result = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(result.rules).toBe("### REVIEW.md\n\nbase review rules\n### AGENTS.md\n\nbase agent rules");
    expect(result.headRules).toBe("untrusted head rules");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(join(tmpdir(), "reviewer", "mirrors", owner), { recursive: true, force: true });
  }
});
