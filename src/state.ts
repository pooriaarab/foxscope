// The stored state and the two stores that need no Node: memory and a
// WebExtension storage area. The Node file store is in node.ts.
import { ScopeError } from "./errors.js";
import type { ScopeState, ScopeStore } from "./types.js";

export const emptyState = (): ScopeState => ({ version: 1, lastNow: 0, rules: [], grants: [], requests: [] });

/** Check a stored state. Nothing stored gives an empty state; anything else that is wrong throws corrupt-store. */
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
    s.rules.every((r) => typeof r?.id === "string" && typeof r.agent === "string" && typeof r.fields === "string" && typeof r.maxTtlSeconds === "number") &&
    s.grants.every((g) => typeof g?.id === "string" && typeof g.agent === "string" && Array.isArray(g.fields) && typeof g.expiresAt === "string") &&
    s.requests.every((r) => typeof r?.id === "string" && typeof r.agent === "string" && Array.isArray(r.fields) && typeof r.digest === "string");
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
