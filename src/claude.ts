import { z } from "zod";
import { CLAUDE_CODE_OAUTH_TOKEN } from "./env";
import { type Claude, Reply, Review } from "./types";

const prompt = (name: string) => Bun.file(new URL(`../prompts/${name}.md`, import.meta.url)).text();
const [reviewInstructions, replyInstructions] = await Promise.all([prompt("review"), prompt("reply")]);

// --safe-mode stops Claude loading CLAUDE.md, settings, hooks and skills from the PR head
const args = [
  "claude", "-p",
  "--restricted", "--safe-mode", "--strict-mcp-config", "--no-session-persistence",
  "--tools", "Read,Grep,Glob",
  "--permission-mode", "dontAsk",
  "--output-format", "json",
];

async function run<T>(dir: string, prompt: string, schema: z.ZodType<T>): Promise<T> {
  const proc = Bun.spawn([...args, "--json-schema", JSON.stringify(z.toJSONSchema(schema, { target: "draft-7" }))], {
    cwd: dir,
    // no FORGEJO_TOKEN or WEBHOOK_SECRET for Claude to leak
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CODE_OAUTH_TOKEN },
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (code) throw new Error(`claude exited ${code}: ${err || out}`);
  const parsed = z.object({ structured_output: schema }).safeParse(JSON.parse(out));
  if (!parsed.success) throw new Error(`claude returned no valid output: ${out}`);
  return parsed.data.structured_output;
}

export const claude: Claude = {
  review({ dir, diff, log, rules, incremental }, large, open) {
    const comments = open.map((c) => `- ${JSON.stringify({ id: c.id, path: c.path, line: c.line, side: c.side, body: c.body })}`).join("\n");
    const heading = [incremental && "new commits only", large && "large PR"].filter(Boolean).join(", ");
    return run(dir, `${reviewInstructions}\n## Repository rules\n\n${rules || "None."}\n\n## Your open comments\n\n${comments || "None."}\n\n## Commits\n\n${log}\n\n## Diff${heading && ` (${heading})`}\n\n${diff}`, Review);
  },
  reply({ dir, diff, log, rules }, comment) {
    return run(dir, `${replyInstructions}\n## Repository rules\n\n${rules || "None."}\n\n## Commits\n\n${log}\n\n## Diff\n\n${diff}\n\n## Comment\n\n${comment}`, Reply);
  },
};
