import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

interface CallOpts<T extends z.ZodType> {
  model: string;
  system: string;
  user: string;
  schema: T;
  effort?: Effort;
  maxTokens?: number;
}

/**
 * Two ways to reach Claude:
 * - "cli" (default): the local `claude` command, billed to your Claude subscription. No API credit needed.
 * - "api": the Anthropic API with ANTHROPIC_API_KEY, billed per token.
 * Set LLM_BACKEND=api in .env to switch.
 */
export const backend = (process.env.LLM_BACKEND ?? "cli") as "cli" | "api";

/** Find the claude binary even when ~/.local/bin isn't on PATH. */
const CLAUDE_BIN =
  process.env.CLAUDE_BIN ??
  [path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((p) => fs.existsSync(p)) ??
  "claude";

export async function structured<T extends z.ZodType>(opts: CallOpts<T>): Promise<z.infer<T>> {
  return backend === "api" ? viaApi(opts) : viaCli(opts);
}

// ---------- subscription via the claude CLI ----------

/** The CLI takes aliases; map full API model ids to the matching family. */
function cliModel(model: string) {
  if (/haiku/.test(model)) return "haiku";
  if (/sonnet/.test(model)) return "sonnet";
  return "opus";
}

const CLI_EFFORT: Record<Effort, string> = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "max" };

function viaCli<T extends z.ZodType>(opts: CallOpts<T>): Promise<z.infer<T>> {
  // The CLI's validator doesn't resolve the draft-2020 meta-schema reference, so drop it.
  const { $schema: _drop, ...jsonSchema } = z.toJSONSchema(opts.schema, { target: "draft-7" }) as Record<string, unknown>;
  const schema = JSON.stringify(jsonSchema);
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", schema,
    "--system-prompt", opts.system,
    "--model", cliModel(opts.model),
    "--effort", CLI_EFFORT[opts.effort ?? "medium"],
    "--tools", "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
  // Without the API key in the environment, the CLI uses the subscription login.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`claude CLI not runnable: ${e.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      let res: any;
      try {
        res = JSON.parse(out);
      } catch {
        return reject(new Error(`claude CLI: ${(err || out).slice(0, 300)}`));
      }
      if (res.is_error) return reject(new Error(`claude CLI: ${String(res.result).slice(0, 300)}`));
      let value = res.structured_output;
      if (value === undefined) {
        try {
          value = JSON.parse(String(res.result).replace(/^```(?:json)?\s*|\s*```$/g, ""));
        } catch {
          return reject(new Error("claude CLI returned no structured output"));
        }
      }
      const parsed = opts.schema.safeParse(value);
      if (!parsed.success) return reject(new Error(`claude CLI output failed validation: ${parsed.error.message.slice(0, 300)}`));
      resolve(parsed.data);
    });
    child.stdin.end(opts.user);
  });
}

/** Quick check used by the dashboard's setup list. */
export function cliLoggedIn(): Promise<boolean> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ["auth", "status"], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0 && !/not logged in/i.test(out)));
  });
}

// ---------- paid API ----------

let client: Anthropic | null = null;

async function viaApi<T extends z.ZodType>(opts: CallOpts<T>): Promise<z.infer<T>> {
  client ??= new Anthropic();
  const stream = client.beta.messages.stream({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: opts.user }],
    output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(opts.schema) },
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error(`model declined: ${msg.stop_details?.category ?? "unknown"}`);
  if (msg.stop_reason === "max_tokens") throw new Error("model output truncated");
  const parsed = msg.parsed_output;
  if (parsed == null) throw new Error("model returned unparseable output");
  return parsed;
}
