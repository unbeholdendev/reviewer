import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

export const { FORGEJO_URL, FORGEJO_TOKEN, WEBHOOK_SECRET, PI_MODEL, PI_API_KEY, PI_AUTH_FILE, CONCURRENCY } = z
  .object({
    FORGEJO_URL: z.url(),
    FORGEJO_TOKEN: z.string().min(1),
    WEBHOOK_SECRET: z.string().min(1),
    PI_MODEL: z
      .string()
      .regex(/^[^/]+\/.+$/, "Expected provider/model-id")
      .default("openai/gpt-6.1-sol"),
    PI_API_KEY: z.string().trim().optional(),
    PI_AUTH_FILE: z.string().min(1).default("credentials/auth.json"),
    CONCURRENCY: z.coerce.number().int().positive().default(2),
  })
  .parse(process.env);

const slash = PI_MODEL.indexOf("/");
export const PI_PROVIDER = PI_MODEL.slice(0, slash);

export function piModel(runtime: ModelRuntime) {
  const model = runtime.getModel(PI_PROVIDER, PI_MODEL.slice(slash + 1));
  if (!model) throw new Error(`Unknown Pi model: ${PI_MODEL}`);
  return model;
}
