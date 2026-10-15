// The foxscope event page. It holds the grants (storage.local) and the trail
// (IndexedDB), asks foxprefs and foxpack for values, and shows a notice on
// each read. Web pages reach it through content.js only.
import { IdbStore, Log, idbKey } from "foxtrail";
import { KNOWN_RESOLVERS, createScope, demoResolver, messageResolver, storageAreaStore } from "../src/index.ts";

const store = browser.storage.local;
const get = async (key, fallback) => (await store.get(key))[key] ?? fallback;
const MAX_NOTICES = 50;

let trail;
const openTrail = () => (trail ??= Promise.all([IdbStore.open("foxscope-trail"), idbKey("foxscope-trail")]).then(([s, key]) => new Log({ store: s, key })));

/** A notice for each read: a Firefox notification, and a line in the manager page. */
async function notify(n) {
  const fields = n.fields.join(", ");
  await browser.notifications.create(`fsc-read:${n.grantId}:${Date.now()}`, {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon-96.png"),
    title: `${n.agent} read your context`,
    message: `${fields}${n.derive ? " (smaller answers)" : ""}. Purpose: ${n.purpose}`,
  });
  const notices = await get("fsc:notices", []);
  await store.set({ "fsc:notices": [{ at: new Date().toISOString(), ...n }, ...notices].slice(0, MAX_NOTICES) });
}

// The demo data is on until the user turns it off in the manager page.
const demoOn = () => get("fsc:demo", true);

// One scope per event page, so its queue orders every change. A new one only when the demo switch moves.
let current;
async function scope() {
  const demo = await demoOn();
  if (current?.demo !== demo) {
    const resolvers = KNOWN_RESOLVERS.map((r) => messageResolver({ namespace: r.namespace, extensionId: r.extensionId, send: (id, msg) => browser.runtime.sendMessage(id, msg) }));
    if (demo) resolvers.push(demoResolver());
    current = { demo, scope: createScope({ resolvers, store: storageAreaStore(store), trail: await openTrail(), notify }) };
  }
  return current.scope;
}

// From content.js. The agent is the origin Firefox reports for the sender; the page cannot set it (E2).
const pageHandlers = {
  "page.request": async (msg, agent) => (await scope()).request({ agent, fields: msg.fields, purpose: msg.purpose, ...(msg.ttlSeconds === undefined ? {} : { ttlSeconds: msg.ttlSeconds }) }),
  "page.read": async (msg, agent) => (await scope()).read(msg.grantId, msg.fields, { agent }),
  "page.revoke": async (msg, agent) => {
    await (await scope()).revoke(msg.grantId, { agent });
    return true;
  },
};

browser.runtime.onMessage.addListener((msg, sender) => {
  const type = msg?.type;
  let run;
  if (typeof type === "string" && type.startsWith("page.") && Object.hasOwn(pageHandlers, type)) {
    // Only a content script in a top frame of an http(s) page may act as an agent.
    let origin;
    try {
      origin = new URL(sender.url).origin;
    } catch {
      origin = "null";
    }
    if (!sender.tab || sender.frameId !== 0 || !/^https?:/.test(origin)) return undefined;
    run = () => pageHandlers[type](msg, origin);
  } else return undefined;
  return run().then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, code: error?.code ?? "error", error: error instanceof Error ? error.message : String(error) }),
  );
});
