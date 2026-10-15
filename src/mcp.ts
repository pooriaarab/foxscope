// The MCP server: an agent asks for context over stdio. The agent is the
// client name from the MCP handshake; each tool sees that agent's grants only.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ScopeError } from "./errors.js";
import { loadResolvers, openScope } from "./node.js";
import type { Scope } from "./scope.js";

export interface McpOptions {
  scope: Scope;
  /** The command the user runs to approve, before the request id. For example "foxscope approve". */
  approveCommand: string;
  version?: string;
}

const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: value }], isError });
const json = (value: unknown) => text(JSON.stringify(value, null, 2));

export function createMcpServer(o: McpOptions): McpServer {
  const server = new McpServer({ name: "foxscope", version: o.version ?? "0.0.0" });
  const agent = () => {
    const name = server.server.getClientVersion()?.name?.trim();
    if (!name) throw new ScopeError("bad-request", "the MCP client sent no client name, and foxscope needs one to know whose grants these are");
    return name;
  };
  const tool = <A extends Record<string, z.ZodType>>(name: string, description: string, inputSchema: A, run: (args: z.infer<z.ZodObject<A>>, agent: string) => Promise<CallToolResult>) =>
    server.registerTool(name, { description, inputSchema }, (async (args: z.infer<z.ZodObject<A>>) => {
      try {
        return await run(args, agent());
      } catch (error) {
        const code = error instanceof ScopeError ? `${error.code}: ` : "";
        return text(`foxscope refused (${code}${error instanceof Error ? error.message : String(error)})`, true);
      }
    }) as never);

  tool("scent_list_fields", "List the context fields you can ask the user for: name, label, sensitivity, and whether a smaller answer exists. Private fields are not listed and can never be read.", {}, async () => {
    const all = await o.scope.fields();
    return json(all.flatMap((r) => r.fields.filter((f) => f.sensitivity !== "private")));
  });

  tool(
    "scent_request",
    "Ask the user for context fields, with a purpose and a time limit. Ask only for what the task needs. Returns the values when a standing rule or an earlier approval covers the request; else the user must approve it first, and you call this tool again with the same fields and purpose.",
    {
      fields: z.array(z.string()).describe('Field names from scent_list_fields, for example ["prefs.shopping.size.top"].'),
      purpose: z.string().describe("Why you need them, in one sentence the user reads."),
      ttlSeconds: z.number().int().optional().describe("How long you need them. The user can give less."),
    },
    async (args, name) => {
      const answer = await o.scope.request({ agent: name, fields: args.fields, purpose: args.purpose, ...(args.ttlSeconds === undefined ? {} : { ttlSeconds: args.ttlSeconds }) });
      if (answer.status === "denied") return text(`foxscope denied the request: ${answer.reason}`, true);
      if (answer.status === "pending") {
        return text(`The user must approve request ${answer.requestId} first. Ask the user to run:\n\n  ${o.approveCommand} ${answer.requestId}\n\nThen call scent_request again with the same fields and purpose.`);
      }
      return text(`Granted: grant ${answer.grantId}, until ${answer.expiresAt}. Use scent_read with this grant id to read again.\n${JSON.stringify(answer.values, null, 2)}`);
    },
  );

  tool(
    "scent_read",
    "Read the fields of one of your live grants again. The user sees a notice for each read.",
    { grantId: z.string(), fields: z.array(z.string()).optional().describe("A part of the granted fields. Default: all of them.") },
    async (args, name) => json(await o.scope.read(args.grantId, args.fields, { agent: name })),
  );

  tool("scent_list_grants", "List your live grants: id, fields, purpose and expiry.", {}, async (_args, name) =>
    json((await o.scope.list({ agent: name })).map((g) => ({ id: g.id, fields: g.fields, purpose: g.purpose, derive: g.derive, expiresAt: g.expiresAt }))),
  );

  tool("scent_revoke", "Give back one of your grants when the task is done.", { grantId: z.string() }, async (args, name) => {
    const g = await o.scope.revoke(args.grantId, { agent: name });
    return text(`Revoked ${g.id}.`);
  });

  return server;
}

/** `foxscope mcp`: the server on stdio, with the state under FOXSCOPE_HOME. Notices go to stderr. */
export async function startMcp(o: { demo: boolean; env: Record<string, string | undefined> }): Promise<void> {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const { resolvers } = await loadResolvers({ demo: o.demo });
  const scope = await openScope({
    home: o.env.FOXSCOPE_HOME || undefined,
    resolvers,
    // An MCP client is a local agent the user starts, so public fields need no approval.
    grantPublic: true,
    notify: (n) => void process.stderr.write(`foxscope notice: ${n.agent} read ${n.fields.join(", ")} (grant ${n.grantId})\n`),
  });
  const server = createMcpServer({ scope, version, approveCommand: o.demo ? "foxscope --demo approve" : "foxscope approve" });
  await server.connect(new StdioServerTransport());
}
