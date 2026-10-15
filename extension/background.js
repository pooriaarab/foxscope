// The foxscope event page. It holds the grants (storage.local) and the trail
// (IndexedDB), asks foxprefs and foxpack for values, opens the approval
// page, and shows a notice on each read. Web pages reach it through
// content.js only; the extension pages reach it with "ui.*" messages.
import { IdbStore, Log, idbKey } from "foxtrail";
import { KNOWN_RESOLVERS, PAGE_MAX_GRANT_SECONDS, PAGE_REFUSAL, createScope, demoResolver, messageResolver, pageError, pageResponse, storageAreaStore } from "../src/index.ts";

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

// The demo data is off until the user turns it on in the manager page (E10).
const demoOn = () => get("fsc:demo", false);

// One scope per event page, so its queue orders every change. A new one only when the demo switch moves.
let current;
async function scope() {
  const demo = await demoOn();
  if (current?.demo !== demo) {
    const resolvers = KNOWN_RESOLVERS.map((r) => messageResolver({ namespace: r.namespace, extensionId: r.extensionId, send: (id, msg) => browser.runtime.sendMessage(id, msg) }));
    if (demo) resolvers.push(demoResolver());
    // Every agent here is a web page: no grant longer than 1 hour (G18), and no public field without the user (G17).
    current = { demo, scope: createScope({ resolvers, store: storageAreaStore(store), trail: await openTrail(), notify, dropped, maxGrantSeconds: PAGE_MAX_GRANT_SECONDS }) };
  }
  return current.scope;
}

/** A request the full list dropped (I8): its tab gets the same "denied" as any refusal, and its approval window closes. */
async function dropped(request) {
  const tab = (await get("fsc:waiting", {}))[request.id];
  await answerTab(request.id, { status: "denied", reason: PAGE_REFUSAL });
  if (tab?.windowId !== undefined) await browser.windows.remove(tab.windowId).catch(() => {});
}

/** Tell the tab that waits for a request what the user decided. A closed tab is fine. */
async function answerTab(requestId, response) {
  const waiting = await get("fsc:waiting", {});
  const tab = waiting[requestId];
  delete waiting[requestId];
  await store.set({ "fsc:waiting": waiting });
  if (tab) await browser.tabs.sendMessage(tab.tabId, { type: "scent.decided", requestId, response }, { frameId: 0 }).catch(() => {});
}

// From content.js. The agent is the origin Firefox reports for the sender; the page cannot set it (E2).
const pageHandlers = {
  async "page.request"(msg, agent, sender) {
    const s = await scope();
    const response = await s.request({ agent, fields: msg.fields, purpose: msg.purpose, ...(msg.ttlSeconds === undefined ? {} : { ttlSeconds: msg.ttlSeconds }) });
    if (response.status === "pending") {
      const waiting = await get("fsc:waiting", {});
      const known = waiting[response.requestId];
      waiting[response.requestId] = { ...known, tabId: sender.tab.id };
      await store.set({ "fsc:waiting": waiting });
      if (!known) {
        // Keep the window id, so a dropped request can close its window.
        const win = await browser.windows.create({ type: "popup", url: browser.runtime.getURL(`approve.html#${response.requestId}`), width: 480, height: 640 });
        const now = await get("fsc:waiting", {});
        if (now[response.requestId]) {
          now[response.requestId].windowId = win.id;
          await store.set({ "fsc:waiting": now });
        }
      }
    }
    return pageResponse(response);
  },
  "page.read": async (msg, agent) => (await scope()).read(msg.grantId, msg.fields, { agent }),
  "page.revoke": async (msg, agent) => {
    await (await scope()).revoke(msg.grantId, { agent });
    return true;
  },
};

// From the extension's own pages.
const uiHandlers = {
  async "ui.state"() {
    const s = await scope();
    const fields = await s.fields();
    const resolvers = KNOWN_RESOLVERS.map((r) => {
      const found = fields.find((f) => f.namespace === r.namespace);
      return { name: r.name, namespace: r.namespace, installed: !found?.error, fields: found?.fields.length ?? 0, error: found?.error };
    });
    return { grants: await s.list(), pending: await s.pending(), rules: await s.rules(), notices: await get("fsc:notices", []), resolvers, demo: await demoOn(), now: Date.now() };
  },
  "ui.request": async ({ requestId }) => (await (await scope()).pending()).find((r) => r.id === requestId) ?? null,
  async "ui.approve"({ requestId, digest, ttlSeconds, derive }) {
    const s = await scope();
    const grant = await s.approve(requestId, { digest, derive: derive === true, ...(ttlSeconds ? { ttlSeconds } : {}) });
    const waiting = await get("fsc:waiting", {});
    if (waiting[requestId]) {
      const values = await s.read(grant.id, undefined, { agent: grant.agent });
      await answerTab(requestId, { status: "granted", grantId: grant.id, expiresAt: grant.expiresAt, values });
    }
    return grant;
  },
  async "ui.deny"({ requestId }) {
    await (await scope()).deny(requestId);
    await answerTab(requestId, { status: "denied", reason: PAGE_REFUSAL });
    return true;
  },
  "ui.revoke": async ({ grantId }) => (await scope()).revoke(grantId),
  "ui.revokeAgent": async ({ agent }) => (await scope()).revokeAgent(agent),
  "ui.addRule": async ({ rule }) => (await scope()).addRule(rule),
  "ui.removeRule": async ({ ruleId }) => (await scope()).removeRule(ruleId),
  "ui.trail": async () => (await openTrail()).entries(),
  "ui.verify": async () => (await scope()).verifyTrail(),
  "ui.demo": async ({ on }) => store.set({ "fsc:demo": on === true }),
};

const ownPage = (sender) => typeof sender.url === "string" && sender.url.startsWith(browser.runtime.getURL(""));

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
    // A page gets "denied" for every refusal (E9); the reason is in the trail.
    return pageHandlers[type](msg, origin, sender).then((value) => ({ ok: true, value }), pageError);
  } else if (ownPage(sender) && Object.hasOwn(uiHandlers, type)) {
    run = () => uiHandlers[type](msg, sender);
  } else return undefined;
  return run().then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, code: error?.code ?? "error", error: error instanceof Error ? error.message : String(error) }),
  );
});

browser.action.onClicked.addListener(() => browser.runtime.openOptionsPage());
