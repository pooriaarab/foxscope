// I8 in docs/failure-modes.md, for the extension: the event page with a
// fake browser. The trail lives in memory in place of IndexedDB.
import { generateKey, MemoryStore } from "foxtrail";
import { expect, it, vi } from "vitest";

vi.mock("foxtrail", async (real) => ({ ...(await real<typeof import("foxtrail")>()), IdbStore: { open: async () => new MemoryStore() }, idbKey: () => generateKey() }));

type Listener = (msg: unknown, sender: unknown) => Promise<unknown> | undefined;

/** A browser with storage, tabs and windows the test can see, then the event page on it. */
async function eventPage() {
  const data: Record<string, unknown> = { "fsc:demo": true };
  const told: { tabId: number; msg: unknown }[] = [];
  const opened: number[] = [];
  const closed: number[] = [];
  let listener: Listener | undefined;
  let nextWindow = 1;
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: async (key: string) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
        set: async (items: Record<string, unknown>) => void Object.assign(data, structuredClone(items)),
      },
    },
    runtime: {
      getURL: (path: string) => `moz-extension://fsc/${path}`,
      sendMessage: () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")),
      onMessage: { addListener: (fn: Listener) => void (listener = fn) },
      openOptionsPage: () => {},
    },
    action: { onClicked: { addListener: () => {} } },
    notifications: { create: async () => "" },
    tabs: { sendMessage: async (tabId: number, msg: unknown) => void told.push({ tabId, msg }) },
    windows: {
      create: async () => {
        opened.push(nextWindow);
        return { id: nextWindow++ };
      },
      remove: async (id: number) => void closed.push(id),
    },
  });
  vi.resetModules();
  const path = "../extension/background.js";
  await import(path);
  const page = (origin: string, tabId: number) => listener!({ type: "page.request", fields: ["demo.travel.home"], purpose: "p" }, { tab: { id: tabId }, frameId: 0, url: `${origin}/` });
  const ui = (msg: Record<string, unknown>) => listener!(msg, { url: "moz-extension://fsc/manager.html" });
  return { page, ui, told, opened, closed };
}

it("I8: a request the full list drops is answered denied, and its approval window closes", async () => {
  const { page, ui, told, opened, closed } = await eventPage();
  const shop = (await page("https://shop.example", 7)) as { value: { requestId: string } };
  const { requestId } = shop.value;
  for (let i = 0; i < 49; i++) await page(`https://${i}.co.de`, 100 + i);
  expect(told).toEqual([]);
  expect(closed).toEqual([]);
  expect(await page("https://49.co.de", 149)).toMatchObject({ ok: true, value: { status: "pending" } });
  expect(told).toEqual([{ tabId: 7, msg: { type: "scent.decided", requestId, response: { status: "denied", reason: "denied" } } }]);
  expect(closed).toEqual([opened[0]]);
  const trail = (await ui({ type: "ui.trail" })) as { value: { kind: string; data: { requestId?: string } }[] };
  expect(trail.value.filter((e) => e.kind === "scent.request.dropped").map((e) => e.data.requestId)).toEqual([requestId]);
});
