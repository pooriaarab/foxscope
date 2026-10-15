// The resolvers of one scope: which fields exist, and their values. A field
// goes to the resolver of its namespace only, so one broken or hostile
// resolver cannot answer for another namespace.
import { ScopeError } from "./errors.js";
import { namespaceOf, parseFieldList } from "./fields.js";
import type { ScentField, ScentResolver } from "./types.js";

export const MAX_VALUE_BYTES = 256 * 1024;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function resolverSet(resolvers: ScentResolver[], timeoutMs = 5000) {
  const byNamespace = new Map<string, ScentResolver>();
  for (const r of resolvers) {
    if (typeof r?.namespace !== "string" || typeof r.list !== "function" || typeof r.read !== "function") throw new ScopeError("bad-resolvers", "each resolver needs a namespace, list() and read()");
    if (byNamespace.has(r.namespace)) throw new ScopeError("bad-resolvers", `two resolvers have the namespace "${r.namespace}"`);
    byNamespace.set(r.namespace, r);
  }
  const list = async (r: ScentResolver) => parseFieldList(r.namespace, await withTimeout(r.list(), timeoutMs, `the ${r.namespace} resolver`));

  return {
    /** The field info for each name, or why one is refused: `unknown-field: x`, `private-field: x` or `resolver-failed: ns`. */
    async describe(names: string[]): Promise<ScentField[] | string> {
      const lists = new Map<string, ScentField[]>();
      for (const ns of new Set(names.map(namespaceOf))) {
        const resolver = byNamespace.get(ns);
        if (!resolver) continue;
        try {
          lists.set(ns, await list(resolver));
        } catch {
          return `resolver-failed: ${ns}`;
        }
      }
      const out: ScentField[] = [];
      for (const name of names) {
        const field = lists.get(namespaceOf(name))?.find((f) => f.name === name);
        if (!field) return `unknown-field: ${name}`;
        out.push(field);
      }
      const priv = out.find((f) => f.sensitivity === "private");
      return priv ? `private-field: ${priv.name}` : out;
    },

    /** The values of names that describe() passed. Keys nobody asked for are dropped. Throws resolver-failed. */
    async resolve(names: string[], derive: boolean): Promise<Record<string, unknown>> {
      const values: Record<string, unknown> = {};
      for (const ns of new Set(names.map(namespaceOf))) {
        const wanted = names.filter((n) => namespaceOf(n) === ns);
        let got: Record<string, unknown>;
        try {
          got = await withTimeout(byNamespace.get(ns)!.read(wanted, { derive }), timeoutMs, `the ${ns} resolver`);
        } catch (error) {
          throw new ScopeError("resolver-failed", `the ${ns} resolver failed: ${message(error)}`);
        }
        if (typeof got !== "object" || got === null) throw new ScopeError("resolver-failed", `the ${ns} resolver did not return an object`);
        for (const n of wanted) if (Object.hasOwn(got, n)) values[n] = got[n];
      }
      if (new TextEncoder().encode(JSON.stringify(values)).length > MAX_VALUE_BYTES) throw new ScopeError("resolver-failed", "the answer is over 256 KB");
      return values;
    },

    /** Every field of every resolver, private ones too, with the error of a resolver that fails. */
    fields(): Promise<{ namespace: string; fields: ScentField[]; error?: string }[]> {
      return Promise.all(
        [...byNamespace.values()].map(async (r) => {
          try {
            return { namespace: r.namespace, fields: await list(r) };
          } catch (error) {
            return { namespace: r.namespace, fields: [], error: message(error) };
          }
        }),
      );
    },
  };
}
