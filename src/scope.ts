// The SCENT reference implementation: scope, consent, exchange, notice, trail.
import { canonicalize, type Log, type VerifyResult } from "foxtrail";
import { ScopeError } from "./errors.js";
import { MAX_TTL_SECONDS, matchGlob, parseRequest, parseRule } from "./fields.js";
import { resolverSet } from "./resolvers.js";
import { parseState } from "./state.js";
import type { Grant, PendingRequest, ReadNotice, Rule, RuleInput, ScentField, ScentRequest, ScentResolver, ScentResponse, ScopeState, ScopeStore } from "./types.js";

export interface ScopeOptions {
  resolvers: ScentResolver[];
  store: ScopeStore;
  /** A foxtrail Log. Every request, decision, read and revoke goes in it. */
  trail: Log;
  /** Standing rules from your config. They hold for the life of the scope and cannot be removed through the API. */
  rules?: RuleInput[];
  /** Runs before each read returns values. If it throws, the read fails with notice-failed. */
  notify?: (notice: ReadNotice) => void | Promise<void>;
  /** The clock in ms. Default: Date.now. */
  now?: () => number;
  /** How long a resolver may take. Default: 5000 ms. */
  resolverTimeoutMs?: number;
}

export const DEFAULT_TTL_SECONDS = 3600;
export const REQUEST_TTL_MS = 10 * 60_000;
export const MAX_PENDING = 50;
export const RATE_LIMIT_PER_MINUTE = 30;
const KEEP_ENDED_MS = 7 * 24 * 3600_000;

export type Scope = ReturnType<typeof createScope>;

const iso = (ms: number) => new Date(ms).toISOString();
const id = (prefix: string) => `${prefix}-${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

async function digestOf(r: ScentRequest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize({ agent: r.agent, fields: r.fields.toSorted(), purpose: r.purpose, ttlSeconds: r.ttlSeconds ?? null }));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function prune(state: ScopeState, now: number) {
  // Expired requests stay a day, so approve can say "expired" and not "not-found".
  state.requests = state.requests.filter((r) => Date.parse(r.expiresAt) > now - 24 * 3600_000);
  state.grants = state.grants.filter((g) => Math.min(Date.parse(g.expiresAt), g.revokedAt ? Date.parse(g.revokedAt) : Infinity) > now - KEEP_ENDED_MS);
}

const live = (g: Grant, now: number) => !g.revokedAt && Date.parse(g.expiresAt) > now;

export function createScope(o: ScopeOptions) {
  const resolvers = resolverSet(o.resolvers, o.resolverTimeoutMs);
  const configRules: Rule[] = (o.rules ?? []).map((input, i) => ({ ...parseRule(input), id: `config-${i + 1}`, source: "config", createdAt: iso(0) }));
  const clock = o.now ?? Date.now;
  const trail = o.trail;
  const recent = new Map<string, number[]>();

  // One change at a time in this process; the store's lock orders processes.
  // fn reads and changes the state and writes the trail, nothing slower: a
  // resolver call or a notice never runs under the lock (S6). Code that needs
  // one does it between two changes, and checks again in the second.
  let queue: Promise<unknown> = Promise.resolve();
  function change<T>(fn: (state: ScopeState, now: number) => Promise<T>): Promise<T> {
    const run = async () => {
      const work = async () => {
        const state = parseState(await o.store.load(), o.store.name);
        const now = Math.max(clock(), state.lastNow);
        state.lastNow = now;
        try {
          return await fn(state, now);
        } finally {
          prune(state, now);
          await o.store.save(state);
        }
      };
      return o.store.lock ? o.store.lock(work) : work();
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  /** The state as it is now, without the lock, for checks that change nothing. */
  async function view<T>(fn: (state: ScopeState, now: number) => T): Promise<T> {
    const state = parseState(await o.store.load(), o.store.name);
    return fn(state, Math.max(clock(), state.lastNow));
  }

  // JSON drops undefined; foxtrail refuses it.
  const log = (actor: string, kind: string, data: Record<string, unknown>) => trail.append({ actor, kind, data: JSON.parse(JSON.stringify(data)) });

  function overLimit(agent: string, now: number): "ok" | "first" | "again" {
    const times = (recent.get(agent) ?? []).filter((t) => t > now - 60_000);
    times.push(now);
    recent.set(agent, times);
    if (times.length <= RATE_LIMIT_PER_MINUTE) return "ok";
    return times.length === RATE_LIMIT_PER_MINUTE + 1 ? "first" : "again";
  }

  /** The grant an agent may read now, and the names to read. Logs and throws a refusal. */
  async function checkGrant(state: ScopeState, now: number, grantId: string, fields: string[] | undefined, agent: string | undefined, info?: ScentField[] | string) {
    const grant = state.grants.find((g) => g.id === grantId && (agent === undefined || g.agent === agent));
    const refuse = async (code: ScopeError["code"], message: string): Promise<never> => {
      if (grant) await log(grant.agent, "scent.read.refused", { grantId, reason: code });
      throw new ScopeError(code, message);
    };
    if (!grant) return refuse("no-grant", `no grant ${grantId}`);
    if (grant.revokedAt) return refuse("revoked", `grant ${grantId} was revoked at ${grant.revokedAt}`);
    if (Date.parse(grant.expiresAt) <= now) return refuse("expired", `grant ${grantId} expired at ${grant.expiresAt}`);
    const names = fields ?? grant.fields;
    if (!Array.isArray(names) || names.length === 0) return refuse("field-not-granted", "fields must be a non-empty array");
    const extra = names.find((n) => !grant.fields.includes(n));
    if (extra !== undefined) return refuse("field-not-granted", `grant ${grantId} does not hold ${String(extra)}`);
    if (typeof info === "string") {
      const [code] = info.split(":") as [ScopeError["code"]];
      return refuse(code === "unknown-field" || code === "private-field" ? code : "resolver-failed", info);
    }
    return { grant: structuredClone(grant), names };
  }

  /** Check, log, notify, then resolve: the trail and the notice come before any value. */
  async function readGrant(grantId: string, fields: string[] | undefined, agent: string | undefined): Promise<Record<string, unknown>> {
    const { names } = await change((state, now) => checkGrant(state, now, grantId, fields, agent));
    const info = await resolvers.describe(names);
    // Check again: the grant may have been revoked while the resolvers answered.
    const { grant } = await change(async (state, now) => {
      const ok = await checkGrant(state, now, grantId, names, agent, info);
      await log(ok.grant.agent, "scent.read", { grantId, fields: names, derive: ok.grant.derive });
      return ok;
    });
    const refuse = async (code: ScopeError["code"], message: string): Promise<never> => {
      await change(() => log(grant.agent, "scent.read.refused", { grantId, reason: code }));
      throw new ScopeError(code, message);
    };
    try {
      await o.notify?.({ agent: grant.agent, grantId, fields: names, purpose: grant.purpose, derive: grant.derive });
    } catch (error) {
      return refuse("notice-failed", `the notice failed, so foxscope gives no values: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      return await resolvers.resolve(names, grant.derive);
    } catch (error) {
      return refuse("resolver-failed", error instanceof Error ? error.message : String(error));
    }
  }

  async function makeGrant(state: ScopeState, now: number, g: Omit<Grant, "id" | "createdAt">, actor: string): Promise<Grant> {
    const made: Grant = { id: id("g"), createdAt: iso(now), ...g };
    await log(actor, "scent.grant", { grantId: made.id, agent: made.agent, purpose: made.purpose, via: made.via, ruleIds: made.ruleIds, requestId: made.requestId, fields: made.fields, derive: made.derive, expiresAt: made.expiresAt });
    state.grants.push(made);
    return made;
  }

  return Object.freeze({
    /** An agent asks for fields. Granted at once when every field is public or under a standing rule, else pending. */
    async request(input: ScentRequest): Promise<ScentResponse> {
      const given = (input as Partial<ScentRequest> | null)?.agent;
      const agent = typeof given === "string" && given.trim() ? given.slice(0, 200) : "unknown";
      const req = parseRequest(input);
      const early = await change(async (_state, now): Promise<ScentResponse | null> => {
        const limit = overLimit(agent, now);
        if (limit !== "ok") {
          if (limit === "first") await log(agent, "scent.refuse", { reason: "rate-limited" });
          return { status: "denied", reason: "rate-limited: more than 30 requests in one minute" };
        }
        if (typeof req === "string") {
          await log(agent, "scent.refuse", { reason: "bad-request" });
          return { status: "denied", reason: `bad-request: ${req}` };
        }
        return null;
      });
      if (early || typeof req === "string") return early!;
      const info = await resolvers.describe(req.fields);
      // The state may have changed while the resolvers answered, so decide on a fresh load.
      const decided = await change(async (state, now): Promise<ScentResponse | Grant> => {
        if (typeof info === "string") {
          await log(req.agent, "scent.refuse", { reason: info, fields: req.fields });
          return { status: "denied", reason: info };
        }
        const existing = state.grants.find((g) => g.agent === req.agent && g.purpose === req.purpose && live(g, now) && req.fields.every((f) => g.fields.includes(f)));
        if (existing) return existing;

        const rules = [...configRules, ...state.rules].filter((r) => r.agent === req.agent);
        const covering = new Set<Rule>();
        const covered = info.every((f) => {
          if (f.sensitivity === "public") return true;
          const r = rules.find((rule) => matchGlob(rule.fields, f.name));
          if (r) covering.add(r);
          return Boolean(r);
        });
        if (covered) {
          const caps = [...covering].map((r) => r.maxTtlSeconds);
          const ttl = Math.min(req.ttlSeconds ?? (caps.length ? Infinity : DEFAULT_TTL_SECONDS), ...caps);
          const via = covering.size ? "rule" : "public";
          return makeGrant(state, now, { agent: req.agent, fields: req.fields, purpose: req.purpose, derive: [...covering].some((r) => r.derive), via, ruleIds: [...covering].map((r) => r.id), expiresAt: iso(now + ttl * 1000) }, via);
        }

        const waiting = state.requests.filter((r) => Date.parse(r.expiresAt) > now);
        const same = waiting.find((r) => r.agent === req.agent && r.purpose === req.purpose && r.ttlSeconds === req.ttlSeconds && sameSet(r.fields.map((f) => f.name), req.fields));
        if (same) return { status: "pending", requestId: same.id };
        if (waiting.length >= MAX_PENDING) {
          await log(req.agent, "scent.refuse", { reason: "too-many-pending", fields: req.fields });
          return { status: "denied", reason: `too-many-pending: ${MAX_PENDING} requests already wait for the user` };
        }
        const pending: PendingRequest = { id: id("r"), agent: req.agent, fields: info, purpose: req.purpose, digest: await digestOf(req), createdAt: iso(now), expiresAt: iso(now + REQUEST_TTL_MS) };
        if (req.ttlSeconds !== undefined) pending.ttlSeconds = req.ttlSeconds;
        await log(req.agent, "scent.request", { requestId: pending.id, fields: req.fields, purpose: req.purpose, ttlSeconds: req.ttlSeconds ?? null });
        state.requests.push(pending);
        return { status: "pending", requestId: pending.id };
      });
      if ("status" in decided) return decided;
      return { status: "granted", grantId: decided.id, expiresAt: decided.expiresAt, values: await readGrant(decided.id, req.fields, req.agent) };
    },

    /** The user approves one waiting request. Pass the digest you showed, to bind the approval to it. */
    async approve(requestId: string, opts: { ttlSeconds?: number; derive?: boolean; digest?: string } = {}): Promise<Grant> {
      const check = (state: ScopeState, now: number) => {
        const req = state.requests.find((r) => r.id === requestId);
        if (!req) throw new ScopeError("not-found", `no waiting request ${requestId}`);
        if (Date.parse(req.expiresAt) <= now) throw new ScopeError("expired", `request ${requestId} expired at ${req.expiresAt}`);
        if (opts.digest !== undefined && opts.digest !== req.digest) throw new ScopeError("request-changed", `request ${requestId} is not the request that was shown`);
        const ttl = opts.ttlSeconds ?? req.ttlSeconds ?? DEFAULT_TTL_SECONDS;
        if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) throw new ScopeError("bad-ttl", `ttlSeconds must be a whole number from 1 to ${MAX_TTL_SECONDS}`);
        return { req, ttl, fields: req.fields.map((f) => f.name) };
      };
      const { fields } = await view(check);
      const info = await resolvers.describe(fields);
      // Check again: the request may have been denied or dropped meanwhile.
      return change(async (state, now) => {
        const { req, ttl } = check(state, now);
        if (typeof info === "string") throw new ScopeError(info.startsWith("private-field") ? "private-field" : info.startsWith("unknown-field") ? "unknown-field" : "resolver-failed", info);
        state.requests = state.requests.filter((r) => r.id !== requestId);
        return makeGrant(state, now, { agent: req.agent, fields, purpose: req.purpose, derive: opts.derive ?? false, via: "user", ruleIds: [], requestId, expiresAt: iso(now + ttl * 1000) }, "user");
      });
    },

    deny: (requestId: string): Promise<void> =>
      change(async (state) => {
        const req = state.requests.find((r) => r.id === requestId);
        if (!req) throw new ScopeError("not-found", `no waiting request ${requestId}`);
        await log("user", "scent.deny", { requestId, agent: req.agent, fields: req.fields.map((f) => f.name) });
        state.requests = state.requests.filter((r) => r.id !== requestId);
      }),

    /** Values for a live grant. Pass `agent` when an agent calls, so it cannot use another agent's grant. */
    read: (grantId: string, fields?: string[], opts: { agent?: string } = {}): Promise<Record<string, unknown>> => readGrant(grantId, fields, opts.agent),

    revoke: (grantId: string, opts: { agent?: string } = {}): Promise<Grant> =>
      change(async (state, now) => {
        const g = state.grants.find((x) => x.id === grantId && (opts.agent === undefined || x.agent === opts.agent));
        if (!g) throw new ScopeError("no-grant", `no grant ${grantId}`);
        if (!g.revokedAt) {
          await log(opts.agent ?? "user", "scent.revoke", { grantId, agent: g.agent });
          g.revokedAt = iso(now);
        }
        return structuredClone(g);
      }),

    /** Revoke every grant of an agent, drop its waiting requests, and remove its standing rules. */
    revokeAgent: (agent: string): Promise<{ grants: number; requests: number; rules: number }> =>
      change(async (state, now) => {
        const grants = state.grants.filter((g) => g.agent === agent && live(g, now));
        const counts = { grants: grants.length, requests: state.requests.filter((r) => r.agent === agent).length, rules: state.rules.filter((r) => r.agent === agent).length };
        await log("user", "scent.revoke", { agent, ...counts });
        for (const g of grants) g.revokedAt = iso(now);
        state.requests = state.requests.filter((r) => r.agent !== agent);
        state.rules = state.rules.filter((r) => r.agent !== agent);
        return counts;
      }),

    /** Live grants: not revoked, not expired. */
    list: (opts: { agent?: string } = {}): Promise<Grant[]> => change(async (state, now) => state.grants.filter((g) => live(g, now) && (opts.agent === undefined || g.agent === opts.agent))),
    pending: (): Promise<PendingRequest[]> => change(async (state, now) => state.requests.filter((r) => Date.parse(r.expiresAt) > now)),

    addRule: (input: RuleInput): Promise<Rule> =>
      change(async (state, now) => {
        const rule: Rule = { ...parseRule(input), id: id("rule"), source: "user", createdAt: iso(now) };
        await log("user", "scent.rule.add", { ruleId: rule.id, agent: rule.agent, fields: rule.fields, maxTtlSeconds: rule.maxTtlSeconds, derive: rule.derive });
        state.rules.push(rule);
        return rule;
      }),
    /** Remove a user rule, and revoke the live grants it made. */
    removeRule: (ruleId: string): Promise<void> =>
      change(async (state, now) => {
        const rule = state.rules.find((r) => r.id === ruleId);
        if (!rule) throw new ScopeError("not-found", `no user rule ${ruleId}`);
        const grants = state.grants.filter((g) => live(g, now) && g.ruleIds.includes(ruleId));
        await log("user", "scent.rule.remove", { ruleId, agent: rule.agent, fields: rule.fields, grants: grants.length });
        for (const g of grants) g.revokedAt = iso(now);
        state.rules = state.rules.filter((r) => r.id !== ruleId);
      }),
    rules: (): Promise<Rule[]> => change(async (state) => [...configRules, ...state.rules]),

    /** Every field the resolvers list, private ones too. Show an agent only `sensitivity !== "private"`. */
    fields: () => resolvers.fields(),

    verifyTrail: (): Promise<VerifyResult> => trail.verify(),
  });
}
