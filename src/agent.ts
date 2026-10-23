import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession, createExtensionRuntime, createFindToolDefinition, createGrepToolDefinition,
  createLsToolDefinition, createReadToolDefinition, ModelRuntime, SessionManager, SettingsManager,
  type ResourceLoader, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { PI_API_KEY, PI_AUTH_FILE, PI_MODEL } from "./env";
import { type Agent, type Note, Reply, Review } from "./types";

const prompt = (name: string) => Bun.file(new URL(`../prompts/${name}.md`, import.meta.url)).text();
const [reviewInstructions, replyInstructions] = await Promise.all([prompt("review"), prompt("reply")]);

const modelRuntime = await ModelRuntime.create({
  credentials: PI_API_KEY ? new InMemoryCredentialStore() : undefined,
  authPath: PI_AUTH_FILE, modelsPath: null, refreshOnCreate: false,
});
const slash = PI_MODEL.indexOf("/");
const provider = PI_MODEL.slice(0, slash);
if (PI_API_KEY) await modelRuntime.setRuntimeApiKey(provider, PI_API_KEY);
const model = modelRuntime.getModel(provider, PI_MODEL.slice(slash + 1));
if (!model) throw new Error(`Unknown Pi model: ${PI_MODEL}`);
if (!PI_API_KEY && (await modelRuntime.checkAuth(provider))?.type !== "oauth") {
  throw new Error(`No Pi subscription login for ${provider} in ${PI_AUTH_FILE}. See README.md for subscription setup, or set PI_API_KEY.`);
}

async function run<T>(dir: string, prompt: string, schema: z.ZodType<T>, signal?: AbortSignal, retry = true): Promise<T> {
  const start = Date.now();
  const format = `Return only a JSON object matching this schema, without Markdown fences or other text:\n${JSON.stringify(z.toJSONSchema(schema, { target: "draft-7" }))}`;
  signal?.throwIfAborted();
  dir = await realpath(dir);
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => `You are a code review assistant. ${format}`,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const definitions: ToolDefinition<any, any>[] = [
    createReadToolDefinition(dir), createGrepToolDefinition(dir),
    createFindToolDefinition(dir), createLsToolDefinition(dir),
  ];
  const { session } = await createAgentSession({
    cwd: dir, model, modelRuntime, resourceLoader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory({ enableInstallTelemetry: false }),
    tools: definitions.map((tool) => tool.name),
    customTools: definitions.map((tool): ToolDefinition<any, any> => ({
      ...tool,
      async execute(id, params: any, signal, onUpdate, ctx) {
        const path = await realpath(resolve(dir, params.path ?? "."));
        if (path !== dir && !path.startsWith(dir + sep)) throw new Error("Path is outside the checkout");
        return tool.execute(id, { ...params, path }, signal, onUpdate, ctx);
      },
    })),
  });
  const cancellation = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(signal ? [signal] : [])]);
  const abort = () => { void session.abort(); };
  cancellation.addEventListener("abort", abort, { once: true });
  let out: string;
  let last: AssistantMessage | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") last = event.message;
  });
  try {
    cancellation.throwIfAborted();
    console.log(`pi started in ${dir}, prompt ${prompt.length} chars`);
    await session.prompt(`${prompt}\n\n${format}`);
    cancellation.throwIfAborted();
    if (!last || last.stopReason !== "stop") throw new Error(last?.errorMessage || `Pi stopped: ${last?.stopReason ?? "no response"}`);
    out = session.getLastAssistantText() ?? "";
  } finally {
    cancellation.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
  let json: unknown;
  try { json = JSON.parse(out); } catch {}
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    if (!retry) throw new Error(`pi returned no valid output: ${out}`);
    console.log("pi gave no valid output, retrying");
    return run(dir, prompt, schema, signal, false);
  }
  console.log(`pi done: model ${PI_MODEL}, ${Date.now() - start}ms`);
  return parsed.data;
}

const notes = (conversation: Note[]) => conversation.map(({ user, path, line, body }) => `- ${JSON.stringify({ user, path, line, body })}`).join("\n");

export const agent: Agent = {
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
