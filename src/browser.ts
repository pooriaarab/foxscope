// A resolver that asks another extension over runtime.sendMessage, as the
// foxscope extension asks foxprefs and foxpack. Those answer only the
// sender id foxscope@pooriaarab, for {type: "scent.list"} and
// {type: "scent.read", fields, derive}, with the value their resolver returns.
import type { ScentResolver } from "./types.js";

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
