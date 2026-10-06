import { z } from "zod";
import { CLAUDE_CODE_OAUTH_TOKEN } from "./env";
import { type Claude, type Note, Reply, Review } from "./types";

const prompt = (name: string) => Bun.file(new URL(`../prompts/${name}.md`, import.meta.url)).text();
const [reviewInstructions, replyInstructions] = await Promise.all([prompt("review"), prompt("reply")]);

// --safe-mode stops Claude loading CLAUDE.md, settings, hooks and skills from the PR head
const args = [
  "claude", "-p",
  "--restricted", "--safe-mode", "--strict-mcp-config", "--no-session-persistence",
  "--tools", "Read,Grep,Glob",
  "--permission-mode", "dontAsk",
  "--output-format", "json",
  "--max-turns", "30",
];

const Stats = z.object({
  num_turns: z.number().optional(),
  duration_ms: z.number().optional(),
  total_cost_usd: z.number().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
});

async function run<T>(dir: string, prompt: string, schema: z.ZodType<T>, signal?: AbortSignal, retry = true): Promise<T> {
  const proc = Bun.spawn([...args, "--json-schema", JSON.stringify(z.toJSONSchema(schema, { target: "draft-7" }))], {
    cwd: dir,
    // no FORGEJO_TOKEN or WEBHOOK_SECRET for Claude to leak
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CODE_OAUTH_TOKEN },
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
    signal,
    timeout: 10 * 60_000,
    killSignal: "SIGKILL",
  });
  console.log(`claude started in ${dir}, prompt ${prompt.length} chars`);
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (code && retry && out.includes('"subtype":"error_max_structured_output_retries"')) {
    console.log("claude gave no valid structured output, retrying");
    return run(dir, prompt, schema, signal, false);
  }
  if (code) throw new Error(`claude exited ${code}: ${err || out}`);
  const json = JSON.parse(out);
  const stats = Stats.safeParse(json).data;
  console.log(`claude done: models ${Object.keys(stats?.modelUsage ?? {}).join(", ")}, ${stats?.num_turns} turns, ${stats?.duration_ms}ms, $${stats?.total_cost_usd}`);
  const parsed = z.object({ structured_output: schema }).safeParse(json);
  if (!parsed.success) throw new Error(`claude returned no valid output: ${out}`);
  return parsed.data.structured_output;
}

const notes = (conversation: Note[]) => conversation.map(({ user, path, line, body }) => `- ${JSON.stringify({ user, path, line, body })}`).join("\n");

export const claude: Claude = {
  review({ dir, diff, log, rules, incremental }, large, open, conversation, signal) {
    const comments = open.map((c) => `- ${JSON.stringify({ id: c.id, path: c.path, line: c.line, side: c.side, body: c.body })}`).join("\n");
    const heading = [incremental && "new commits only", large && "large PR"].filter(Boolean).join(", ");
    return run(dir, `${reviewInstructions}\n## Repository rules\n\n${rules || "None."}\n\n## Conversation\n\n${notes(conversation)}\n\n## Your open comments\n\n${comments || "None."}\n\n## Commits\n\n${log}\n\n## Diff${heading && ` (${heading})`}\n\n${diff}`, Review, signal);
  },
  reply({ dir, diff, log, rules }, comment, thread, conversation, login) {
    const history = thread ? `## Thread on \`${thread[0].path}:${thread[0].line}\`\n\n${thread.map((c) => `- ${JSON.stringify({ user: c.user, body: c.body })}`).join("\n")}\n\n` : "";
    return run(dir, `${replyInstructions}\nYou are @${login}. Comments by \`${login}\` are yours.\n\n## Repository rules\n\n${rules || "None."}\n\n## Conversation\n\n${notes(conversation)}\n\n## Commits\n\n${log}\n\n## Diff\n\n${diff}\n\n${history}## Comment\n\n${comment}`, Reply);
  },
};
