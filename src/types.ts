// SCENT v0.1: Scoped Context Exchange with Notice and Trail. foxprefs and
// foxpack copy these interfaces; keep them identical in all three repos.
export type Sensitivity = "public" | "ask" | "private";
export interface ScentField {
  name: string;
  label: string;
  sensitivity: Sensitivity;
  derivable?: boolean;
}
export interface ScentResolver {
  namespace: string; // "prefs", "memory", ...
  list(): Promise<ScentField[]>;
  read(fields: string[], opts: { derive: boolean }): Promise<Record<string, unknown>>;
}
export interface ScentRequest {
  agent: string;
  fields: string[];
  purpose: string;
  ttlSeconds?: number;
}
export type ScentResponse =
  | { status: "granted"; grantId: string; expiresAt: string; values: Record<string, unknown> }
  | { status: "pending"; requestId: string }
  | { status: "denied"; reason: string };

/** A standing rule: this agent may read fields that match the glob, for at most maxTtlSeconds. */
export interface Rule {
  id: string;
  agent: string;
  /** `<namespace>.<path>`, where `*` is one segment and a final `**` is the rest. */
  fields: string;
  maxTtlSeconds: number;
  /** Give the smaller answers only. */
  derive: boolean;
  /** "config" rules come from createScope({ rules }) and cannot be removed through the API. */
  source: "config" | "user";
  createdAt: string;
}
export type RuleInput = Pick<Rule, "agent" | "fields" | "maxTtlSeconds"> & { derive?: boolean };

export interface Grant {
  id: string;
  agent: string;
  fields: string[];
  purpose: string;
  derive: boolean;
  /** Who granted it: the user, standing rules, or no one because every field is public. */
  via: "user" | "rule" | "public";
  ruleIds: string[];
  requestId?: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

/** A request that waits for the user. `digest` binds an approval to these exact bytes. */
export interface PendingRequest {
  id: string;
  agent: string;
  fields: ScentField[];
  purpose: string;
  ttlSeconds?: number;
  digest: string;
  createdAt: string;
  expiresAt: string;
}

export interface ScopeState {
  version: 1;
  /** The latest time foxscope saw, so a clock that goes back cannot revive a grant. */
  lastNow: number;
  rules: Rule[];
  grants: Grant[];
  requests: PendingRequest[];
  /** The rate limit by site (siteOf): request times in ms of the last minute, and the last refusal that went to the trail. Kept here so a restart does not reset it. */
  rate: Record<string, { times: number[]; refusedAt?: number }>;
}

/** Where a scope keeps its state. `lock`, when there is one, orders writers across processes. */
export interface ScopeStore {
  /** Names the store in errors, for example the file path. */
  name?: string;
  load(): Promise<unknown>;
  save(state: ScopeState): Promise<void>;
  lock?<T>(fn: () => Promise<T>): Promise<T>;
}

/** What the notice callback gets on each read. */
export interface ReadNotice {
  agent: string;
  grantId: string;
  fields: string[];
  purpose: string;
  derive: boolean;
}
