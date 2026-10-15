// The foxscope command. runCli is the whole CLI; bin.ts only wires it to the process.
import { parseArgs } from "node:util";
import { ScopeError } from "./errors.js";
import { loadResolvers, openScope } from "./node.js";
import type { Grant, PendingRequest, ReadNotice } from "./types.js";

export interface CliIo {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** For tests: how foxprefs and foxpack are imported. */
  importModule?: (name: string) => Promise<Record<string, unknown>>;
}

export const USAGE = `Usage: foxscope [--demo] <command>

  rules add <agent> <field-glob> --ttl <seconds> [--derive]
  rules list
  rules remove <rule-id>
  request <agent> <field>... --purpose "<why>" [--ttl <seconds>]
  pending
  approve <request-id> [--ttl <seconds>] [--derive]
  deny <request-id>
  grants
  read <grant-id> [<field>...]
  revoke <grant-id> | revoke --agent <agent>
  fields
  trail [--verify]

--demo adds the demo resolver (made-up values in the "demo" namespace).
State and trail: FOXSCOPE_HOME, else ~/.foxscope.
`;

class UsageError extends Error {}

const seconds = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`--ttl must be a whole number of seconds: ${value}`);
  return Number(value);
};
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function describeGrant(g: Grant): string {
  return `${g.id}  ${g.agent}  ${g.fields.join(", ")}${g.derive ? " (smaller answers)" : ""}  until ${g.expiresAt}  via ${g.via}\n  Purpose: ${JSON.stringify(g.purpose)}\n`;
}

function describeRequest(r: PendingRequest): string {
  const fields = r.fields.map((f) => `  - ${f.name} (${f.label}, ${f.sensitivity}${f.derivable ? ", has a smaller answer" : ""})\n`).join("");
  return `${r.id}  ${r.agent}  wants ${r.ttlSeconds ? `${r.ttlSeconds} s` : "the default time (1 hour)"}, waits until ${r.expiresAt}\n  Purpose: ${JSON.stringify(r.purpose)}\n${fields}`;
}

const OPTIONS = {
  demo: { type: "boolean", default: false },
  ttl: { type: "string" },
  derive: { type: "boolean", default: false },
  purpose: { type: "string" },
  agent: { type: "string" },
  verify: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;
const parse = (argv: string[]) => parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (error) {
    io.stderr(`foxscope: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values: v, positionals: p } = args;
  if (v.help) {
    io.stdout(USAGE);
    return 0;
  }
  const [command, ...rest] = p;
  const need = (n: number) => {
    if (rest.length < n) throw new UsageError(`${command} needs ${n} argument${n > 1 ? "s" : ""}`);
  };

  try {
    const known = ["rules", "request", "pending", "approve", "deny", "grants", "read", "revoke", "fields", "trail"];
    if (!command || !known.includes(command)) throw new UsageError(command ? `unknown command: ${command}` : "no command");
    const ttl = seconds(v.ttl);
    const { resolvers, status } = await loadResolvers({ demo: v.demo, importModule: io.importModule });
    const notify = (n: ReadNotice) => io.stderr(`notice: ${n.agent} read ${n.fields.join(", ")} (grant ${n.grantId})\n`);
    const scope = await openScope({ home: io.env.FOXSCOPE_HOME || undefined, resolvers, notify });

    switch (command) {
      case "rules": {
        const [sub, ...r] = rest;
        if (sub === "add") {
          if (r.length < 2 || ttl === undefined) throw new UsageError("rules add needs <agent> <field-glob> --ttl <seconds>");
          const rule = await scope.addRule({ agent: r[0]!, fields: r[1]!, maxTtlSeconds: ttl, derive: v.derive });
          io.stdout(`Added rule ${rule.id}: ${rule.agent} may read ${rule.fields} for up to ${rule.maxTtlSeconds} s${rule.derive ? " (smaller answers)" : ""}.\n`);
        } else if (sub === "list") {
          const rules = await scope.rules();
          io.stdout(rules.length ? rules.map((x) => `${x.id}  ${x.agent} ${x.fields} up to ${x.maxTtlSeconds} s${x.derive ? " (smaller answers)" : ""}  ${x.source}\n`).join("") : "No rules.\n");
        } else if (sub === "remove") {
          if (!r[0]) throw new UsageError("rules remove needs <rule-id>");
          await scope.removeRule(r[0]);
          io.stdout(`Removed rule ${r[0]}.\n`);
        } else throw new UsageError("rules needs add, list or remove");
        return 0;
      }
      case "request": {
        need(2);
        if (v.purpose === undefined) throw new UsageError("request needs --purpose");
        const answer = await scope.request({ agent: rest[0]!, fields: rest.slice(1), purpose: v.purpose, ...(ttl === undefined ? {} : { ttlSeconds: ttl }) });
        if (answer.status === "denied") {
          io.stderr(`foxscope: denied: ${answer.reason}\n`);
          return 1;
        }
        if (answer.status === "pending") io.stdout(`pending ${answer.requestId}. The user approves with: foxscope approve ${answer.requestId}\n`);
        else io.stdout(`granted ${answer.grantId} until ${answer.expiresAt}\n${json(answer.values)}`);
        return 0;
      }
      case "pending": {
        const list = await scope.pending();
        io.stdout(list.length ? list.map(describeRequest).join("") : "Nothing waits.\n");
        return 0;
      }
      case "approve": {
        need(1);
        const g = await scope.approve(rest[0]!, { ...(ttl === undefined ? {} : { ttlSeconds: ttl }), derive: v.derive });
        io.stdout(`Approved for ${g.agent}: ${g.fields.join(", ")}${g.derive ? " (smaller answers)" : ""}\nPurpose: ${JSON.stringify(g.purpose)}\nThis is grant ${g.id}, until ${g.expiresAt}.\n`);
        return 0;
      }
      case "deny":
        need(1);
        await scope.deny(rest[0]!);
        io.stdout(`Denied ${rest[0]}.\n`);
        return 0;
      case "grants": {
        const list = await scope.list();
        io.stdout(list.length ? list.map(describeGrant).join("") : "No live grants.\n");
        return 0;
      }
      case "read":
        need(1);
        io.stdout(json(await scope.read(rest[0]!, rest.length > 1 ? rest.slice(1) : undefined)));
        return 0;
      case "revoke": {
        if (v.agent !== undefined) {
          const n = await scope.revokeAgent(v.agent);
          io.stdout(`Revoked ${v.agent}: ${n.grants} grants, ${n.requests} waiting requests, ${n.rules} rules.\n`);
        } else {
          need(1);
          const g = await scope.revoke(rest[0]!);
          io.stdout(`Revoked ${g.id} (${g.agent}).\n`);
        }
        return 0;
      }
      case "fields": {
        for (const [name, state] of Object.entries(status)) io.stdout(`${name}: ${state}\n`);
        const all = await scope.fields();
        const lines = all.flatMap((r) => (r.error ? [`${r.namespace}: failed: ${r.error}`] : r.fields.map((f) => `${f.name}  ${f.label}  ${f.sensitivity}${f.derivable ? "  derivable" : ""}`)));
        io.stdout(lines.length ? `${lines.join("\n")}\n` : "No fields. Install foxprefs or foxpack, or pass --demo.\n");
        return 0;
      }
      default: {
        // trail
        for (const e of await scope.trail.entries()) io.stdout(`${e.seq}  ${new Date(e.ts).toISOString()}  ${e.actor}  ${e.kind}  ${JSON.stringify(e.data)}\n`);
        if (v.verify) {
          const result = await scope.verifyTrail();
          if (!result.ok) {
            io.stderr(`foxscope: the trail is broken at entry ${result.index}: ${result.reason}: ${result.message}\n`);
            return 1;
          }
          io.stdout(`Trail OK: ${result.count} entries, head ${result.head}\n`);
        }
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`foxscope: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    const msg = error instanceof ScopeError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
    io.stderr(`foxscope: ${msg}\n`);
    return 1;
  }
}
