// Checks for what an agent sends, and the field globs of standing rules.
import { ScopeError } from "./errors.js";
import type { RuleInput, ScentField, ScentRequest } from "./types.js";

export const MAX_FIELDS = 50;
export const MAX_PURPOSE = 500;
export const MAX_AGENT = 200;
/** 30 days: the longest grant, rule or request time. */
export const MAX_TTL_SECONDS = 30 * 24 * 3600;

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const NAMESPACE = /^[a-z][a-z0-9-]*$/;

/** True for `<namespace>.<path>`, for example `prefs.shopping.size.top`. */
export function isFieldName(name: unknown): name is string {
  if (typeof name !== "string" || name.length > 200) return false;
  const parts = name.split(".");
  return parts.length >= 2 && NAMESPACE.test(parts[0] ?? "") && parts.every((p) => SEGMENT.test(p));
}

export const namespaceOf = (name: string) => name.slice(0, name.indexOf("."));

function checkAgent(agent: unknown): string | null {
  if (typeof agent !== "string" || !agent.trim()) return "agent must be a non-empty string";
  if (agent.length > MAX_AGENT) return `agent must be at most ${MAX_AGENT} characters`;
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(agent)) return "agent must not hold control characters";
  return null;
}

function checkTtl(ttl: unknown, name: string): string | null {
  if (!Number.isInteger(ttl) || (ttl as number) <= 0 || (ttl as number) > MAX_TTL_SECONDS) return `${name} must be a whole number from 1 to ${MAX_TTL_SECONDS}`;
  return null;
}

/** Check a request. Returns the clean request, or the reason it is bad. Reads own data only. */
export function parseRequest(input: unknown): ScentRequest | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "the request must be an object";
  const r = input as Record<string, unknown>;
  const agentProblem = checkAgent(r.agent);
  if (agentProblem) return agentProblem;
  const fields = r.fields;
  if (!Array.isArray(fields) || fields.length === 0) return "fields must be a non-empty array";
  if (fields.length > MAX_FIELDS) return `fields must hold at most ${MAX_FIELDS} names`;
  const bad = fields.find((f) => !isFieldName(f));
  if (bad !== undefined) return `fields holds a name that is not <namespace>.<path>: ${JSON.stringify(bad)?.slice(0, 80)}`;
  if (new Set(fields).size !== fields.length) return "fields repeats a name";
  if (typeof r.purpose !== "string" || !r.purpose.trim()) return "purpose must be a non-empty string";
  if (r.purpose.length > MAX_PURPOSE) return `purpose must be at most ${MAX_PURPOSE} characters`;
  if (r.ttlSeconds !== undefined) {
    const ttlProblem = checkTtl(r.ttlSeconds, "ttlSeconds");
    if (ttlProblem) return ttlProblem;
  }
  const out: ScentRequest = { agent: r.agent as string, fields: [...(fields as string[])], purpose: r.purpose };
  if (r.ttlSeconds !== undefined) out.ttlSeconds = r.ttlSeconds as number;
  return out;
}

/** True for a glob such as `prefs.shopping.*` or `prefs.**`. The namespace is always fixed. */
export function isFieldGlob(glob: unknown): glob is string {
  if (typeof glob !== "string" || glob.length > 200) return false;
  const parts = glob.split(".");
  if (parts.length < 2 || !NAMESPACE.test(parts[0] ?? "")) return false;
  return parts.every((p, i) => (i > 0 && p === "*") || (i === parts.length - 1 && i > 0 && p === "**") || SEGMENT.test(p));
}

export function matchGlob(glob: string, name: string): boolean {
  const g = glob.split(".");
  const n = name.split(".");
  for (let i = 0; i < g.length; i++) {
    if (g[i] === "**") return n.length > i;
    if (i >= n.length || (g[i] !== "*" && g[i] !== n[i])) return false;
  }
  return g.length === n.length;
}

/** Check a standing rule. Throws ScopeError bad-rule. */
export function parseRule(input: RuleInput): RuleInput & { derive: boolean } {
  const agentProblem = checkAgent(input?.agent);
  if (agentProblem) throw new ScopeError("bad-rule", agentProblem);
  if (!isFieldGlob(input.fields)) throw new ScopeError("bad-rule", `fields must be a glob that starts with a namespace, for example prefs.shopping.*: ${JSON.stringify(input.fields)}`);
  const ttlProblem = checkTtl(input.maxTtlSeconds, "maxTtlSeconds");
  if (ttlProblem) throw new ScopeError("bad-rule", ttlProblem);
  if (input.derive !== undefined && typeof input.derive !== "boolean") throw new ScopeError("bad-rule", "derive must be true or false");
  return { agent: input.agent, fields: input.fields, maxTtlSeconds: input.maxTtlSeconds, derive: input.derive ?? false };
}

/** Check the field list a resolver returns. Fields outside its namespace are dropped. */
export function parseFieldList(namespace: string, list: unknown): ScentField[] {
  if (!Array.isArray(list)) throw new Error("list() did not return an array");
  const out: ScentField[] = [];
  for (const f of list as unknown[]) {
    const field = f as Partial<ScentField> | null;
    if (typeof field !== "object" || field === null || !isFieldName(field.name) || typeof field.label !== "string" || !["public", "ask", "private"].includes(field.sensitivity as string)) {
      throw new Error(`list() returned a field in the wrong shape: ${JSON.stringify(f)?.slice(0, 120)}`);
    }
    if (field.derivable !== undefined && typeof field.derivable !== "boolean") throw new Error(`list() returned derivable that is not a boolean for ${field.name}`);
    if (namespaceOf(field.name) !== namespace) continue;
    out.push({ name: field.name, label: field.label, sensitivity: field.sensitivity as ScentField["sensitivity"], ...(field.derivable ? { derivable: true } : {}) });
  }
  return out;
}
