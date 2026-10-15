# foxscope

[![npm version](https://img.shields.io/npm/v/foxscope)](https://www.npmjs.com/package/foxscope)
[![Downloads/month](https://img.shields.io/npm/dm/foxscope)](https://www.npmjs.com/package/foxscope)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Quickstart](#grant-your-first-field) · [API reference](#runtime-surfaces) · [The SCENT contract](#the-scent-contract) · [Limits](#limits)

foxscope gives AI agents only the context you grant: scoped, expiring grants with notice and a trail.
It is the reference implementation of SCENT, Scoped Context Exchange with Notice and Trail.
An agent asks for named fields, a purpose and a time. You approve, or a standing rule does.
The agent gets only those values, you see each read, and a tamper-evident trail logs every step.

## Install

```bash
npm install foxscope
```

The library runs in Node.js 24 or later and in Firefox 153 or later.
TypeScript declarations are included. The runtime dependencies are foxtrail (the trail), and the MCP SDK and zod for the MCP server.

## Grant your first field

The CLI keeps its state in `FOXSCOPE_HOME` (default `~/.foxscope`).
`--demo` adds made-up values in the `demo` namespace, so you need no other package.

```bash
export FOXSCOPE_HOME=/tmp/foxscope-try
npx foxscope --demo request shop-agent demo.shopping.size.top demo.shopping.budget --purpose "Pick clothes"
npx foxscope pending
npx foxscope --demo approve r-<id> --derive
npx foxscope --demo read g-<id>
npx foxscope trail --verify
```

`request` prints `pending r-<id>` and the command to approve it. `approve --derive` gives the smaller answers.
`read` prints `{"demo.shopping.size.top": "M", "demo.shopping.budget": "100-250 CAD"}`, and a notice on stderr.
`trail --verify` lists three entries (request, grant, read) and ends with `Trail OK: 3 entries`.

The same flow in code:

```js
import { createScope, demoResolver, memoryStore } from "foxscope";
import { Log, MemoryStore, generateKey } from "foxtrail";

const scope = createScope({
  resolvers: [demoResolver()],
  store: memoryStore(),
  trail: new Log({ store: new MemoryStore(), key: await generateKey() }),
  notify: (n) => console.log(`${n.agent} read ${n.fields.join(", ")}`),
});
const asked = await scope.request({ agent: "shop-agent", fields: ["demo.shopping.size.top"], purpose: "Pick clothes" });
const [pending] = await scope.pending();
const grant = await scope.approve(asked.requestId, { digest: pending.digest, ttlSeconds: 600 });
console.log(await scope.read(grant.id)); // { 'demo.shopping.size.top': 'M' }
console.log((await scope.verifyTrail()).ok); // true
```

## How it works

```text
agent: request(fields, purpose, ttl)
  -> check the shape            -> denied: bad-request
  -> ask each field's resolver  -> denied: unknown-field / private-field
  -> live grant for the same fields and purpose?  -> granted (values)
  -> every field under a standing rule?           -> granted (values)
     (or public, for a local agent: grantPublic)
  -> else pending: the user approves (bound to the request digest) or denies

read(grant): live and not revoked? -> trail entry -> notice -> resolver values
```

1. **Scope.** A field name is `<namespace>.<path>`, for example `prefs.shopping.size.top`. A field goes to the resolver of its namespace only.
2. **Consent.** The user approves one exact request, or a standing rule names the agent, a field glob and a longest time. A changed purpose or field list is a new request. A `public` field needs no approval only in a scope made with `grantPublic: true`: the CLI and the MCP server set it for the local agents you start. The extension does not, so a web page gets nothing, public fields included, without your approval or a standing rule.
3. **Exchange.** A read returns only the granted fields. A `derive` grant gives the smaller answer, for example a budget band in place of the number.
4. **Notice.** foxscope calls `notify` before it reads a value. If the notice fails, the read fails.
5. **Trail.** Each request, refusal, grant, denial, read, refused read, revoke and rule change is a [foxtrail](https://github.com/pooriaarab/foxtrail) entry. The trail holds field names and ids, never values.

`private` fields never reach an agent, also when a rule matches them.

## Why it exists

An agent that helps you shop, book or write needs some of your context, not all of it.
Today that context goes into a prompt or a vendor's memory, and you cannot see or end its use.
foxscope keeps the context in your browser or on your computer, gives it out field by field, and lets you revoke it.

## Compare

Checked on 2026-10-15 against the [Solid Protocol](https://solidproject.org/TR/protocol) and [RFC 6749 (OAuth 2.0)](https://www.rfc-editor.org/rfc/rfc6749).

| Property | foxscope | Solid | OAuth 2.0 scopes |
|---|---|---|---|
| Where the data is | Your browser or your computer | Storages on servers | The resource server |
| Unit of access | Named fields | Resources, with WAC or ACP rules | Scope strings that the authorization server defines |
| Time limit | Each grant expires (1 s to 30 days) | Not set by the protocol | Token lifetime (`expires_in`) |
| Smaller answers | Yes, per field (`derive`) | No | No |
| Notice per use | Yes | No | No |
| Audit trail | Tamper-evident, built in | Not in the protocol | Not in the protocol |

## Coverage

| Surface | Status | Verified by |
|---|---|---|
| Library (`foxscope`) | Implemented | 78 vitest tests for the failure modes in `docs/failure-modes.md` |
| Node store (`foxscope/node`) | Implemented | Lock, atomic write and corrupt-store tests on real files |
| CLI (`foxscope`) | Implemented | Tests through `runCli` |
| MCP server (`foxscope mcp`) | Implemented | Tests with the MCP SDK client over its in-memory transport |
| Firefox extension | Implemented | Firefox E2E, local and on Ichabod |
| foxprefs and foxpack resolvers | Wired, not yet run | Message tests with stand-ins; the packages are not published yet |

## The SCENT contract

foxprefs and foxpack copy these types. They do not depend on foxscope.

```ts
export type Sensitivity = "public" | "ask" | "private";
export interface ScentField { name: string; label: string; sensitivity: Sensitivity; derivable?: boolean }
export interface ScentResolver {
  namespace: string;
  list(): Promise<ScentField[]>;
  read(fields: string[], opts: { derive: boolean }): Promise<Record<string, unknown>>;
}
export interface ScentRequest { agent: string; fields: string[]; purpose: string; ttlSeconds?: number }
export type ScentResponse =
  | { status: "granted"; grantId: string; expiresAt: string; values: Record<string, unknown> }
  | { status: "pending"; requestId: string }
  | { status: "denied"; reason: string };
```

In Firefox, the foxscope extension sends `{type: "scent.list"}` and `{type: "scent.read", fields, derive}` to `foxprefs@pooriaarab` (namespace `prefs`) and `foxpack@pooriaarab` (namespace `memory`) with `runtime.sendMessage`.
The answer is the value that `list()` or `read()` returns: a `ScentField[]` or a record of values.
In Node, the CLI imports `foxprefs` and `foxpack` when they are installed next to foxscope, and calls `prefsResolver()` and `memoryResolver()`.

## Runtime surfaces

### Library: `foxscope`

| Export | What it does |
|---|---|
| `createScope({ resolvers, store, trail, rules?, notify?, now?, resolverTimeoutMs?, grantPublic? })` | Returns a scope. `trail` is a foxtrail `Log`. `rules` are standing rules from your config. `notify` runs before each read. `grantPublic` (default false) grants `public` fields without asking; use it for local agents only. |
| `scope.request(req)` | Returns a `ScentResponse`. Policy refusals are `denied` with a reason. |
| `scope.approve(requestId, { ttlSeconds?, derive?, digest? })` | The user's yes. Pass the `digest` you showed. Returns the grant. Default time: what the agent asked, else 1 hour. |
| `scope.deny(requestId)` | The user's no. |
| `scope.read(grantId, fields?, { agent? })` | The values. Pass `agent` when an agent calls, so it cannot use another agent's grant. |
| `scope.revoke(grantId, { agent? })`, `scope.revokeAgent(agent)` | End one grant, or every grant, waiting request and rule of an agent. |
| `scope.list({ agent? })`, `scope.pending()` | Live grants and waiting requests. |
| `scope.addRule({ agent, fields, maxTtlSeconds, derive? })`, `scope.removeRule(id)`, `scope.rules()` | Standing rules. `fields` is a glob: `*` is one segment, a final `**` is the rest. It starts with a fixed namespace. Removing a rule revokes the live grants it made. |
| `scope.fields()` | Every field of every resolver, with the error of a resolver that fails. |
| `scope.verifyTrail()` | Checks the trail chain. |
| `memoryStore()`, `storageAreaStore(area)` | Stores for tests and for `browser.storage.local`. |
| `demoResolver()` | Made-up values in the `demo` namespace. |
| `messageResolver({ namespace, extensionId, send })` | A resolver in another extension, over `runtime.sendMessage`. |
| `ScopeError` | Every thrown refusal. `code` is one of `bad-request`, `bad-rule`, `bad-resolvers`, `bad-ttl`, `not-found`, `expired`, `request-changed`, `no-grant`, `revoked`, `field-not-granted`, `private-field`, `unknown-field`, `resolver-failed`, `notice-failed`, `corrupt-store`, `store-busy`. |

### Node: `foxscope/node`

| Export | What it does |
|---|---|
| `openScope({ resolvers, home?, notify?, rules? })` | A scope with `state.json`, `trail.jsonl` and `trail.key` under `home` (default `FOXSCOPE_HOME`, else `~/.foxscope`). |
| `fileStore(path)` | The state file, with a lock file for more than one process. |
| `loadResolvers({ demo })` | The foxprefs and foxpack resolvers when installed, and their status. |

### CLI

```text
foxscope [--demo] rules add <agent> <field-glob> --ttl <seconds> [--derive]
foxscope rules list | rules remove <rule-id>
foxscope [--demo] request <agent> <field>... --purpose "<why>" [--ttl <seconds>]
foxscope pending
foxscope [--demo] approve <request-id> [--ttl <seconds>] [--derive]
foxscope deny <request-id>
foxscope grants
foxscope [--demo] read <grant-id> [<field>...]
foxscope revoke <grant-id> | revoke --agent <agent>
foxscope [--demo] fields
foxscope trail [--verify]
foxscope [--demo] mcp
```

Exit 0 is done, 1 is a refusal (the code goes to stderr), 2 is bad usage.
`approve` checks the fields again, so give it the same `--demo` as the request.

### MCP server

`foxscope mcp` serves five tools on stdio: `scent_list_fields`, `scent_request`, `scent_read`, `scent_list_grants` and `scent_revoke`.
The agent is the client name from the MCP handshake. A client sees and revokes only its own grants.
A waiting request returns the command the user runs, for example `foxscope approve r-1a2b3c4d5e6f`.
After the approval, the agent calls `scent_request` again with the same fields and purpose.

```json
{ "mcpServers": { "foxscope": { "command": "npx", "args": ["foxscope", "mcp"] } } }
```

### Firefox extension

`extension/` is the foxscope add-on. Web pages on https get `window.scent`:

```js
const answer = await window.scent.request({ fields: ["prefs.shopping.size.top"], purpose: "Pick a size", ttlSeconds: 3600 });
if (answer.status === "granted") console.log(answer.values);
await window.scent.read(answer.grantId);
await window.scent.revoke(answer.grantId);
```

The agent is the page origin. A page gets one refusal for everything, `denied`: a private field, an unknown field, a missing add-on, an ended grant and your deny look the same to it. The reason is in the trail on the manager page.
A request that needs you opens an approval window: the origin, the purpose, each field with its sensitivity, and the time, with Approve, Approve smaller answers and Deny.
The manager page shows live grants with a countdown, waiting requests, standing rules, recent reads, the trail with Verify, and which of foxprefs and foxpack are installed.
Each read shows a Firefox notification.
The demo data (made-up values in the `demo` namespace) is off on a fresh install; turn it on in the manager page to try foxscope.

```bash
pnpm install
pnpm build:ext   # load dist-ext/manifest.json from about:debugging
pnpm e2e         # the Firefox E2E; FOXKIT_BROWSER=ichabod runs it on Ichabod
```

## Limits

- An agent can keep a value it read. Revoke stops the next read, not a copy.
- The trail is tamper-evident, not tamper-proof. Anyone with the trail key can rewrite it. In Node the key is `trail.key`, next to the trail.
- A notice in Node is a line on stderr. The CLI and the MCP server show no desktop notification.
- A page agent is an origin, so every script on that origin shares its grants.
- foxprefs and foxpack are not on npm yet, so they are not declared as optional peers. Install them next to foxscope with npm. Under pnpm, foxscope cannot import a package it does not declare.
- One event page owns the extension state. Do not run a second scope on the same storage.
- A read with an unknown grant id is not logged, so a page cannot fill the trail with guesses.
- The rate limit counts per process. Each CLI call starts at zero.
- There are no quiet hours for notices. foxscope shows each read.

## Status

foxscope 0.x can change its API and its state format before 1.0.
Report problems through [GitHub issues](https://github.com/pooriaarab/foxscope/issues).

## License

[MIT](LICENSE)
