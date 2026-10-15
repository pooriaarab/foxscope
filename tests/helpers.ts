// A scope on memory stores with a clock the test moves.
import { Log, MemoryStore, generateKey, type Store } from "foxtrail";
import { createScope, demoResolver, memoryStore, type ReadNotice, type RuleInput, type ScentField, type ScentResolver } from "../src/index.js";

export const T0 = Date.parse("2026-10-15T12:00:00Z");

export async function setup(o: { resolvers?: ScentResolver[]; rules?: RuleInput[]; notify?: (n: ReadNotice) => void | Promise<void>; trailStore?: Store; resolverTimeoutMs?: number; grantPublic?: boolean; maxGrantSeconds?: number } = {}) {
  let t = T0;
  const clock = { now: () => t, advance: (seconds: number) => void (t += seconds * 1000), set: (ms: number) => void (t = ms) };
  const trailStore = o.trailStore ?? new MemoryStore();
  const trail = new Log({ store: trailStore, key: await generateKey() });
  const store = memoryStore();
  const notices: ReadNotice[] = [];
  const scope = createScope({
    resolvers: o.resolvers ?? [demoResolver()],
    store,
    trail,
    rules: o.rules,
    notify: o.notify ?? ((n) => void notices.push(n)),
    now: clock.now,
    resolverTimeoutMs: o.resolverTimeoutMs,
    grantPublic: o.grantPublic,
    maxGrantSeconds: o.maxGrantSeconds,
  });
  const entries = () => trail.entries();
  const kinds = async () => (await entries()).map((e) => e.kind);
  return { scope, clock, trail, trailStore, store, notices, entries, kinds };
}

/** A resolver whose fields and answers the test controls. */
export function fakeResolver(namespace: string, fields: ScentField[], read: ScentResolver["read"] = async (names) => Object.fromEntries(names.map((n) => [n, `value of ${n}`]))) {
  const calls: { fields: string[]; derive: boolean }[] = [];
  const resolver: ScentResolver = {
    namespace,
    list: async () => fields,
    read: async (names, opts) => {
      calls.push({ fields: names, derive: opts.derive });
      return read(names, opts);
    },
  };
  return { resolver, calls };
}

export const SIZES = ["demo.shopping.size.top", "demo.shopping.size.shoe"];
export const shop = { agent: "https://shop.example", fields: SIZES, purpose: "Pick clothes that fit" };
