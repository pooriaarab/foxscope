// The manager page (the add-on options): live grants with a countdown,
// waiting requests, standing rules, recent reads, the trail and the context
// sources. Agent text goes in with textContent only.
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

async function send(type, data = {}) {
  const reply = await browser.runtime.sendMessage({ type, ...data });
  if (!reply?.ok) throw new Error(reply?.error ?? "no answer from foxscope");
  return reply.value;
}

const pad = (n) => String(n).padStart(2, "0");
function left(ms) {
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)} d ${h % 24} h left`;
  return h ? `${h}:${pad(m)}:${pad(s % 60)} left` : `${m}:${pad(s % 60)} left`;
}
const duration = (s) => (s % 86400 === 0 ? `${s / 86400} d` : s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);
const site = (agent) => el("span", { className: "site-icon", textContent: (agent.replace(/^https?:\/\//, "")[0] ?? "?").toUpperCase() });
const chips = (names) => el("div", { className: "chips" }, ...names.map((n) => el("code", { className: "chip", textContent: n })));
const fill = (box, nodes, empty) => box.replaceChildren(...(nodes.length ? nodes : [el("p", { className: "note empty", textContent: empty })]));

function act(button, fn) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await fn();
    } catch (error) {
      button.title = error.message;
      button.disabled = false;
    }
  });
  return button;
}

function render(state) {
  fill(
    $("grants"),
    state.grants.map((g) => {
      const card = el("div", { className: "card grant" }, el("div", { className: "ask-head" }, site(g.agent), el("span", { className: "site", textContent: g.agent }), el("span", { className: "countdown note", textContent: left(Date.parse(g.expiresAt) - Date.now()) })));
      card.dataset.grant = g.id;
      card.querySelector(".countdown").dataset.expires = g.expiresAt;
      card.append(
        chips(g.fields),
        el("p", { className: "note", textContent: `Purpose: ${g.purpose}${g.derive ? " · smaller answers" : ""} · ${g.via === "user" ? "you approved it" : g.via === "rule" ? "a standing rule" : "public fields"}` }),
        el("div", { className: "answers" }, act(el("button", { className: "ghost small", textContent: "Revoke this agent" }), () => send("ui.revokeAgent", { agent: g.agent })), act(el("button", { className: "danger small revoke", textContent: "Revoke" }), () => send("ui.revoke", { grantId: g.id }))),
      );
      return card;
    }),
    "No agent can read anything now.",
  );
  fill(
    $("pending"),
    state.pending.map((r) => {
      const card = el("div", { className: "card" }, el("div", { className: "ask-head" }, site(r.agent), el("span", { className: "site", textContent: r.agent })), chips(r.fields.map((f) => f.name)), el("p", { className: "note", textContent: `Purpose: ${r.purpose}` }));
      card.dataset.request = r.id;
      card.append(el("div", { className: "answers" }, el("a", { className: "review", href: `approve.html#${r.id}`, target: "_blank", textContent: "Review" })));
      return card;
    }),
    "Nothing waits for you.",
  );
  fill(
    $("rules"),
    state.rules.map((r) => {
      const row = el("div", { className: "row rule" }, el("span", { textContent: `${r.agent} may read ${r.fields} for up to ${duration(r.maxTtlSeconds)}${r.derive ? ", smaller answers only" : ""}` }));
      row.append(r.source === "user" ? act(el("button", { className: "small", textContent: "Remove" }), () => send("ui.removeRule", { ruleId: r.id })) : el("span", { className: "note", textContent: "from config" }));
      return row;
    }),
    "No standing rules. Every request asks you.",
  );
  const reads = state.notices.map((n) => el("li", { textContent: `${new Date(n.at).toLocaleTimeString()} · ${n.agent} read ${n.fields.join(", ")}${n.derive ? " (smaller answers)" : ""}` }));
  $("notices").replaceChildren(...(reads.length ? reads : [el("li", { className: "note empty", textContent: "No agent has read anything yet." })]));
  const demo = el("input", { type: "checkbox", id: "demo", checked: state.demo });
  demo.addEventListener("change", () => send("ui.demo", { on: demo.checked }));
  $("resolvers").replaceChildren(
    ...state.resolvers.map((r) => {
      const row = el("p", { className: "row" }, el("span", { className: `dot ${r.installed ? "ok" : "bad"}` }), `${r.name}: ${r.installed ? `installed, ${r.fields} fields in "${r.namespace}"` : "not installed"}`);
      row.dataset.resolver = r.name;
      return row;
    }),
    el("label", { className: "switch" }, demo, 'Demo data: made-up values in the "demo" namespace, for trying foxscope'),
  );
}

async function renderTrail() {
  const entries = (await send("ui.trail")).slice(-50).toReversed();
  $("trail").tBodies[0].replaceChildren(...entries.map((e) => el("tr", {}, el("td", { textContent: new Date(e.ts).toLocaleTimeString() }), el("td", { textContent: e.actor }), el("td", { textContent: e.kind.replace(/^scent\./, "") }), el("td", { textContent: JSON.stringify(e.data).slice(0, 160) }))));
}

let loading;
const load = () =>
  (loading ??= Promise.all([send("ui.state").then(render), renderTrail()])
    .catch((error) => ($("grants").textContent = `foxscope refused: ${error.message}`))
    .finally(() => (loading = undefined)));

act($("verify"), async () => {
  const result = await send("ui.verify");
  $("verify-status").textContent = result.ok ? `Trail OK: ${result.count} entries, nothing changed.` : `The trail is broken at entry ${result.index}: ${result.message}`;
  $("verify").disabled = false;
});

act($("rule-add"), async () => {
  try {
    await send("ui.addRule", { rule: { agent: $("rule-agent").value.trim(), fields: $("rule-fields").value.trim(), maxTtlSeconds: Number($("rule-ttl").value), derive: $("rule-derive").checked } });
    $("rule-status").textContent = "Added.";
  } catch (error) {
    $("rule-status").textContent = error.message;
  }
  $("rule-add").disabled = false;
});

// The countdowns tick each second; a grant that runs out reloads the lists.
setInterval(() => {
  for (const c of document.querySelectorAll(".countdown")) {
    const ms = Date.parse(c.dataset.expires) - Date.now();
    c.textContent = left(ms);
    if (ms <= 0 && ms > -1000) load();
  }
}, 1000);
browser.storage.onChanged.addListener(() => load());
load();
