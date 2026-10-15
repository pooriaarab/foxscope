// The page API: window.scent.request, window.scent.read and window.scent.revoke.
// The page is not trusted. It gets functions made with exportFunction and
// values made with cloneInto, and never a reference to this script's objects.
// Its arguments are copied field by field: through Xray vision this script
// sees only plain own data, so page getters and proxies give nothing (E1).
const WAIT_MS = 10 * 60_000;
const waiting = new Map(); // requestId -> [{ resolve, reject, timer }]

const page = window.wrappedJSObject;
const fail = (message) => new window.Error(`foxscope: ${message}`);

function strings(value, name, max) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw fail(`${name} must be an array of strings`);
  const out = [];
  for (let i = 0; i < value.length && i <= max; i++) {
    if (typeof value[i] !== "string") throw fail(`${name} must be an array of strings`);
    out.push(value[i]);
  }
  return out;
}

function copyRequest(input) {
  if (typeof input !== "object" || input === null) throw fail("request takes { fields, purpose, ttlSeconds }");
  const purpose = input.purpose;
  const ttl = input.ttlSeconds;
  if (typeof purpose !== "string") throw fail("purpose must be a string");
  if (ttl !== undefined && typeof ttl !== "number") throw fail("ttlSeconds must be a number");
  return { fields: strings(input.fields, "fields", 50) ?? [], purpose, ...(ttl === undefined ? {} : { ttlSeconds: ttl }) };
}

async function send(msg) {
  const reply = await browser.runtime.sendMessage(msg);
  if (!reply?.ok) throw fail(reply ? `${reply.code}: ${reply.error}` : "no answer from the extension");
  return reply.value;
}

/** A page promise that settles with a clone of what fn gives. */
function pagePromise(fn) {
  return new window.Promise(
    exportFunction((resolve, reject) => {
      fn().then(
        (value) => resolve(cloneInto(value, window)),
        (error) => reject(error instanceof window.Error ? error : fail(error instanceof Error ? error.message : String(error))),
      );
    }, window),
  );
}

function request(input) {
  return pagePromise(async () => {
    const response = await send({ type: "page.request", ...copyRequest(input) });
    if (response.status !== "pending") return response;
    // Wait for the user's answer, which the background sends to this tab (E6).
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fail("the request expired before the user answered")), WAIT_MS);
      const list = waiting.get(response.requestId) ?? [];
      list.push({ resolve, timer });
      waiting.set(response.requestId, list);
    });
  });
}

function read(grantId, fields) {
  return pagePromise(async () => {
    if (typeof grantId !== "string") throw fail("read takes a grant id");
    return send({ type: "page.read", grantId, fields: strings(fields, "fields", 50) });
  });
}

function revoke(grantId) {
  return pagePromise(async () => {
    if (typeof grantId !== "string") throw fail("revoke takes a grant id");
    return send({ type: "page.revoke", grantId });
  });
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "scent.decided") return;
  for (const w of waiting.get(msg.requestId) ?? []) {
    clearTimeout(w.timer);
    w.resolve(msg.response);
  }
  waiting.delete(msg.requestId);
});

const scent = cloneInto({ version: "0.1" }, window);
exportFunction(request, scent, { defineAs: "request" });
exportFunction(read, scent, { defineAs: "read" });
exportFunction(revoke, scent, { defineAs: "revoke" });
// A page cannot replace window.scent with its own.
Reflect.defineProperty(page, "scent", { value: scent, enumerable: true, configurable: false, writable: false });
page.dispatchEvent(new window.Event("scent-ready"));
