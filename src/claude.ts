import { z } from "zod";
import { CLAUDE_CODE_OAUTH_TOKEN } from "./env";
import { type Claude, Review } from "./types";

const instructions = await Bun.file(new URL("../prompts/review.md", import.meta.url)).text();
const Output = z.object({ structured_output: Review });

// --safe-mode stops Claude loading CLAUDE.md, settings, hooks and skills from the PR head
const args = [
  "claude", "-p",
  "--restricted", "--safe-mode", "--strict-mcp-config", "--no-session-persistence",
  "--tools", "Read,Grep,Glob",
  "--permission-mode", "dontAsk",
  "--output-format", "json",
  "--json-schema", JSON.stringify(z.toJSONSchema(Review, { target: "draft-7" })),
];

export const claude: Claude = {
  async review({ dir, diff, log, rules, incremental }, large, open) {
    const comments = open.map((c) => `- ${JSON.stringify({ id: c.id, path: c.path, line: c.line, side: c.side, body: c.body })}`).join("\n");
    const heading = [incremental && "new commits only", large && "large PR"].filter(Boolean).join(", ");
    const prompt = `${instructions}\n## Repository rules\n\n${rules || "None."}\n\n## Your open comments\n\n${comments || "None."}\n\n## Commits\n\n${log}\n\n## Diff${heading && ` (${heading})`}\n\n${diff}`;
    const proc = Bun.spawn(args, {
      cwd: dir,
      // no FORGEJO_TOKEN or WEBHOOK_SECRET for Claude to leak
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CODE_OAUTH_TOKEN },
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    if (code) throw new Error(`claude exited ${code}: ${err || out}`);
    const parsed = Output.safeParse(JSON.parse(out));
    if (!parsed.success) throw new Error(`claude returned no valid review: ${out}`);
    return parsed.data.structured_output;
  },
};
