// A resolver that asks another extension over runtime.sendMessage, as the
// foxscope extension asks foxprefs and foxpack. Those answer only the
// sender id foxscope@pooriaarab, for {type: "scent.list"} and
// {type: "scent.read", fields, derive}, with the value their resolver returns.
import type { ScentResolver, ScentResponse } from "./types.js";

export type SendMessage = (extensionId: string, message: unknown) => Promise<unknown>;

export function messageResolver(o: { namespace: string; extensionId: string; send: SendMessage }): ScentResolver {
  const ask = async (message: unknown) => {
    try {
      return await o.send(o.extensionId, message);
    } catch (error) {
      throw new Error(`${o.extensionId} is not installed or does not answer (${error instanceof Error ? error.message : String(error)})`, { cause: error });
    }
  };
  return {
    namespace: o.namespace,
    // resolverSet checks the shape of both answers.
    list: () => ask({ type: "scent.list" }) as never,
    read: (fields, { derive }) => ask({ type: "scent.read", fields, derive }) as never,
  };
}

/** The two SCENT resolvers that the foxscope extension knows. */
export const KNOWN_RESOLVERS = [
  { name: "foxprefs", namespace: "prefs", extensionId: "foxprefs@pooriaarab" },
  { name: "foxpack", namespace: "memory", extensionId: "foxpack@pooriaarab" },
] as const;

/**
 * What a web page gets for a refusal: the one word "denied". A reason such
 * as `private-field: x` or `resolver-failed: memory` would tell the page
 * which fields and add-ons the user has. The reason stays in the trail.
 */
export const PAGE_REFUSAL = "denied";

/** A request answer as a page may see it. */
export const pageResponse = (r: ScentResponse): ScentResponse => (r.status === "denied" ? { status: "denied", reason: PAGE_REFUSAL } : r);

/** Any thrown error as a page may see it. */
export const pageError = (_error: unknown) => ({ ok: false as const, code: PAGE_REFUSAL, error: PAGE_REFUSAL });

/** The longest grant a web page can get: 1 hour. The extension makes its scope with this cap. */
export const PAGE_MAX_GRANT_SECONDS = 3600;
