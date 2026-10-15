// The approval page: approve.html#<request-id>. Everything the agent wrote
// (its origin, the purpose) goes in with textContent, never as HTML, and
// invisible and direction characters are shown as codes, so a request
// cannot hide what it asks for.
const requestId = location.hash.slice(1);
const $ = (id) => document.getElementById(id);

async function send(type, data = {}) {
  const reply = await browser.runtime.sendMessage({ type, ...data });
  if (!reply?.ok) throw new Error(reply?.error ?? "no answer from foxscope");
  return reply.value;
}

// oxlint-disable-next-line no-control-regex
const visible = (text) => text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
const SENSITIVITY = { public: ["ok", "public"], ask: ["asks", "asks you"] };

function duration(s) {
  if (s % 86400 === 0) return `${s / 86400} day${s === 86400 ? "" : "s"}`;
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? "" : "s"}`;
  if (s % 60 === 0) return `${s / 60} minute${s === 60 ? "" : "s"}`;
  return `${s} seconds`;
}

let request = null;

function render(r) {
  request = r;
  const host = (() => {
    try {
      return new URL(r.agent).host;
    } catch {
      return r.agent;
    }
  })();
  $("icon").textContent = (host[0] ?? "?").toUpperCase();
  $("agent").textContent = visible(r.agent);
  $("purpose").textContent = visible(r.purpose);
  $("fields").replaceChildren(
    ...r.fields.map((f) => {
      const li = document.createElement("li");
      const text = document.createElement("div");
      text.append(Object.assign(document.createElement("span"), { className: "label", textContent: f.label }), Object.assign(document.createElement("code"), { textContent: f.name }));
      const [dot, word] = SENSITIVITY[f.sensitivity] ?? ["bad", f.sensitivity];
      const chip = Object.assign(document.createElement("span"), { className: "chip" });
      chip.append(Object.assign(document.createElement("span"), { className: `dot ${dot}` }), word);
      li.append(text, chip);
      if (f.derivable) li.append(Object.assign(document.createElement("span"), { className: "chip", textContent: "smaller answer" }));
      return li;
    }),
  );
  const asked = r.ttlSeconds;
  const options = [...new Set([asked, 300, 3600, 86400].filter(Boolean))].toSorted((a, b) => a - b);
  $("ttl").replaceChildren(...options.map((s) => Object.assign(document.createElement("option"), { value: String(s), textContent: duration(s) + (s === asked ? " (asked)" : ""), selected: s === (asked ?? 3600) })));
  const derivable = r.fields.some((f) => f.derivable);
  $("smaller").hidden = !derivable;
  $("smaller-note").hidden = !derivable;
  $("request").hidden = false;
}

async function decide(kind) {
  for (const b of document.querySelectorAll(".answers button")) b.disabled = true;
  try {
    if (kind === "deny") {
      await send("ui.deny", { requestId });
      $("decision").textContent = "Denied.";
    } else {
      const grant = await send("ui.approve", { requestId, digest: request.digest, ttlSeconds: Number($("ttl").value), derive: kind === "smaller" });
      $("decision").textContent = `Approved${grant.derive ? " with smaller answers" : ""}, until ${new Date(grant.expiresAt).toLocaleString()}.`;
    }
    $("request").hidden = true;
    // Close the popup that the background opened; a tab stays.
    const win = await browser.windows.getCurrent().catch(() => null);
    if (win?.type === "popup") setTimeout(() => window.close(), 1500);
  } catch (error) {
    $("decision").textContent = `foxscope refused: ${error.message}`;
    for (const b of document.querySelectorAll(".answers button")) b.disabled = false;
  }
}

$("approve").addEventListener("click", () => decide("approve"));
$("smaller").addEventListener("click", () => decide("smaller"));
$("deny").addEventListener("click", () => decide("deny"));

send("ui.request", { requestId }).then(
  (r) => (r ? render(r) : ($("decision").textContent = "This request no longer waits. It was answered, or it expired.")),
  (error) => ($("decision").textContent = `foxscope refused: ${error.message}`),
);
