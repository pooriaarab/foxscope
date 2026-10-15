// The approval page: approve.html#<request-id>. Everything the agent wrote
// (its origin, the purpose) goes in with textContent, never as HTML, and
// invisible and direction characters are shown as codes, so a request
// cannot hide what it asks for.
import { PAGE_MAX_GRANT_SECONDS } from "../src/browser.ts";
import { visible } from "../src/fields.ts";

const requestId = location.hash.slice(1);
const $ = (id) => document.getElementById(id);

async function send(type, data = {}) {
  const reply = await browser.runtime.sendMessage({ type, ...data });
  if (!reply?.ok) throw new Error(reply?.error ?? "no answer from foxscope");
  return reply.value;
}

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
  // A page gets at most PAGE_MAX_GRANT_SECONDS (G18), whatever it asks.
  const asked = r.ttlSeconds;
  const top = Math.min(asked ?? PAGE_MAX_GRANT_SECONDS, PAGE_MAX_GRANT_SECONDS);
  const note = (s) => (s !== top ? "" : s === asked ? " (asked)" : asked ? ` (asked ${duration(asked)}; ${duration(PAGE_MAX_GRANT_SECONDS)} is the most)` : "");
  const options = [...new Set([top, 300, 900, PAGE_MAX_GRANT_SECONDS])].filter((s) => s <= top).toSorted((a, b) => a - b);
  $("ttl").replaceChildren(...options.map((s) => Object.assign(document.createElement("option"), { value: String(s), textContent: duration(s) + note(s), selected: s === top })));
  const derivable = r.fields.some((f) => f.derivable);
  $("smaller").hidden = !derivable;
  $("smaller-note").hidden = !derivable;
  $("request").hidden = false;
  arm();
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
    $("deny").disabled = false;
    arm();
  }
}

// A page can open this window under the user's pointer and time a click on
// it (E11). The approve buttons wake 1 s after the window is shown or gets
// focus, and sleep again when it loses focus. Deny needs no delay.
const ARM_MS = 1000;
let armTimer;
const setArmed = (on) => {
  for (const id of ["approve", "smaller"]) $(id).disabled = !on;
};
function arm() {
  setArmed(false);
  clearTimeout(armTimer);
  armTimer = setTimeout(() => setArmed(true), ARM_MS);
}
function disarm() {
  clearTimeout(armTimer);
  setArmed(false);
}
window.addEventListener("focus", arm);
window.addEventListener("blur", disarm);
document.addEventListener("visibilitychange", () => (document.hidden ? disarm() : arm()));

$("approve").addEventListener("click", () => decide("approve"));
$("smaller").addEventListener("click", () => decide("smaller"));
$("deny").addEventListener("click", () => decide("deny"));

send("ui.request", { requestId }).then(
  (r) => (r ? render(r) : ($("decision").textContent = "This request no longer waits. It was answered, or it expired.")),
  (error) => ($("decision").textContent = `foxscope refused: ${error.message}`),
);
