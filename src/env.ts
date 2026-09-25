import { z } from "zod";

export const { FORGEJO_URL, FORGEJO_TOKEN, WEBHOOK_SECRET, CLAUDE_CODE_OAUTH_TOKEN, CONCURRENCY } = z
  .object({
    FORGEJO_URL: z.url(),
    FORGEJO_TOKEN: z.string().min(1),
    WEBHOOK_SECRET: z.string().min(1),
    CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),
    CONCURRENCY: z.coerce.number().int().positive().default(2),
  })
  .parse(process.env);
