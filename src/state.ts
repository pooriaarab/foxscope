// The stored state and the two stores that need no Node: memory and a
// WebExtension storage area. The Node file store is in node.ts.
import { ScopeError } from "./errors.js";
import type { Grant, PendingRequest, Rule, ScentField, ScopeState, ScopeStore } from "./types.js";

export const emptyState = (): ScopeState => ({ version: 1, lastNow: 0, rules: [], grants: [], requests: [] });

const str = (x: unknown): x is string => typeof x === "string";
const strings = (x: unknown) => Array.isArray(x) && x.every(str);
/** An exact ISO time, as toISOString() writes it. "garbage" or "2026-10-15" is not one. */
const date = (x: unknown) => str(x) && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString() === x;
const seconds = (x: unknown) => Number.isInteger(x) && (x as number) > 0;
const field = (f: Partial<ScentField> | null) => str(f?.name) && str(f.label) && ["public", "ask", "private"].includes(f.sensitivity as string) && (f.derivable === undefined || typeof f.derivable === "boolean");

const rule = (r: Partial<Rule> | null) => str(r?.id) && str(r.agent) && str(r.fields) && seconds(r.maxTtlSeconds) && typeof r.derive === "boolean" && (r.source === "user" || r.source === "config") && date(r.createdAt);
const grant = (g: Partial<Grant> | null) =>
  str(g?.id) &&
  str(g.agent) &&
  strings(g.fields) &&
  str(g.purpose) &&
  typeof g.derive === "boolean" &&
  ["user", "rule", "public"].includes(g.via as string) &&
  strings(g.ruleIds) &&
  (g.requestId === undefined || str(g.requestId)) &&
  date(g.createdAt) &&
  date(g.expiresAt) &&
  (g.revokedAt === undefined || date(g.revokedAt));
const request = (r: Partial<PendingRequest> | null) =>
  str(r?.id) && str(r.agent) && Array.isArray(r.fields) && r.fields.every(field) && str(r.purpose) && (r.ttlSeconds === undefined || seconds(r.ttlSeconds)) && str(r.digest) && date(r.createdAt) && date(r.expiresAt);

/** Check a stored state, each date and each field. Nothing stored gives an empty state; anything else that is wrong throws corrupt-store. */
export function parseState(value: unknown, where = "the store"): ScopeState {
  if (value === undefined || value === null) return emptyState();
  const s = value as Partial<ScopeState>;
  const ok =
    typeof s === "object" &&
    s.version === 1 &&
    typeof s.lastNow === "number" &&
    Number.isFinite(s.lastNow) &&
    Array.isArray(s.rules) &&
    Array.isArray(s.grants) &&
    Array.isArray(s.requests) &&
    s.rules.every(rule) &&
    s.grants.every(grant) &&
    s.requests.every(request);
  if (!ok) throw new ScopeError("corrupt-store", `${where} does not hold a foxscope state (version 1). foxscope does not overwrite it. Move it away to start again.`);
  return structuredClone(s as ScopeState);
}

/** State in memory, for tests and short runs. */
export function memoryStore(initial?: ScopeState): ScopeStore {
  let saved: ScopeState | undefined = initial && structuredClone(initial);
  return {
    load: async () => saved && structuredClone(saved),
    save: async (state) => {
      saved = structuredClone(state);
    },
  };
}

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** State in a WebExtension storage area, for example browser.storage.local. Use it from one page only. */
export function storageAreaStore(area: StorageArea, key = "fsc:state"): ScopeStore {
  return {
    load: async () => (await area.get(key))[key],
    save: (state) => area.set({ [key]: state }),
  };
}
