import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedLines, withoutSkipped } from "../src/diff";
import type { Agent } from "../src/types";

const usage = "Usage: bun eval/pr.ts <clone> <base> <head> <output.json> [description-file]";

export type PullCase = { clone: string; base: string; head: string; description?: string };

async function git(clone: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", clone, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (code) throw new Error(`git ${args.join(" ")} exited ${code}: ${err}`);
  return out;
}

export async function reviewPull(agent: Pick<Agent, "review">, { clone, base, head, description }: PullCase, signal: AbortSignal) {
  const diff = withoutSkipped(await git(clone, "diff", `${base}...${head}`));
  const log = await git(clone, "log", `${base}..${head}`);
  const rules = await Promise.all(
    ["REVIEW.md", "AGENTS.md"].map((f) => git(clone, "show", `${base}:${f}`).then((t) => `### ${f}\n\n${t}`, () => "")),
  );
  const dir = join(tmpdir(), "reviewer-eval", randomUUID());
  await git(clone, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", dir, head);
  try {
    const conversation = description ? [{ user: "author", body: description, at: "" }] : [];
    const review = await agent.review({ dir, diff, log, rules: rules.filter(Boolean).join("\n") }, false, [], conversation, signal);
    return { review, changed: changedLines(diff) };
  } finally {
    await git(clone, "worktree", "remove", "--force", dir);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--help") return console.log(`${usage}

Reviews base...head of a local clone with the real model, using PI_MODEL and PI_AUTH_FILE or PI_API_KEY.
Never partial. Saves the review as JSON. No Forgejo or Git network calls.`);
  const [clone, base, head, output, descriptionFile] = args;
  if (!clone || !base || !head || !output || args.length > 5) throw new Error(usage);
  const description = descriptionFile ? await Bun.file(descriptionFile).text() : undefined;
  process.env.FORGEJO_URL ??= "https://forgejo.invalid";
  process.env.FORGEJO_TOKEN ??= "unused-by-eval";
  process.env.WEBHOOK_SECRET ??= "unused-by-eval";
  const { agent } = await import("../src/agent");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  const start = Date.now();
  const { review, changed } = await reviewPull(agent, { clone, base, head, description }, controller.signal);
  await Bun.write(output, `${JSON.stringify(review, null, 2)}\n`);
  console.log(`${review.recommendation}, ${review.comments.length} comments, ${changed} changed lines, ${Date.now() - start}ms: ${output}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("ERROR:", error);
    process.exitCode = 1;
  });
}
