# Failure modes

Every way foxscope can fail, written before the code. Each row names the
behaviour we want and the test that checks it. A test file names the rows it
covers. Prefer an E2E check. Write an isolated test only when an E2E check
cannot reach the failure.

foxscope stands between an agent and the user's context. The worst failure is
a value that reaches an agent without a grant. So the rule for every row: when
in doubt, refuse, and say why.

## Requests (input from an agent)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| I1 | A request has no agent, an agent over 200 characters, or an agent with control characters | `denied`, reason `bad-request: agent ...` | tests/fields.test.ts, tests/request.test.ts |
| I2 | `fields` is not an array, is empty, has more than 50 names, repeats a name, or holds a name that is not `<namespace>.<path>` | `denied`, reason `bad-request: fields ...` | tests/fields.test.ts |
| I3 | `purpose` is missing, empty, or over 500 characters | `denied`, reason `bad-request: purpose ...` | tests/fields.test.ts |
| I4 | `ttlSeconds` is not a whole number, is 0 or less, or is over 30 days | `denied`, reason `bad-request: ttlSeconds ...` | tests/fields.test.ts |
| I5 | A field name has no resolver, or its resolver does not list it | `denied`, reason `unknown-field: <name>` | tests/request.test.ts |
| I6 | An agent sends the same request again while it waits | The same `requestId`; no second pending entry | tests/request.test.ts |
| I7 | An agent floods requests | After 30 requests in one minute from one site (I9): `denied` `rate-limited`. Only the first refusal in that minute goes to the trail | tests/request.test.ts |
| I8 | More than 50 requests wait at one time | The list keeps 50. A request from a site with fewer waiting requests than the site with the most drops that site's oldest request (`scent.request.dropped` in the trail). Any other request gets `denied` `too-many-pending` | tests/request.test.ts |
| I9 | A page floods from many subdomains (each one a new origin), fills the shared waiting list so every other site gets `too-many-pending`, or waits out an event-page restart that resets the limiter | The limit and the waiting list count per site: a page origin is grouped by its registrable domain (`siteOf`, which drops a final dot, so `a.evil.com.` is `evil.com`), any other agent is its own site. One site gets 30 requests a minute and at most 3 waiting requests, and a full list never refuses a site that has fewer waiting than the biggest one (I8), so 17 sites under `co.de` cannot shut out a site with nothing waiting. The limiter is kept in the stored state, so a restart or a new process does not reset it | tests/request.test.ts, tests/fields.test.ts |

## Private data

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| P1 | A request names a `private` field | `denied` `private-field: <name>`, also when a standing rule matches the field. No approval is ever asked | tests/request.test.ts, E2E |
| P2 | A field becomes `private` after the grant | `read` refuses it with `private-field` | tests/read.test.ts |
| P3 | A resolver returns more keys than were asked for | foxscope drops the extra keys | tests/resolvers.test.ts |
| P4 | A resolver lists a field outside its own namespace | foxscope ignores that field, so a resolver cannot answer for another one | tests/fields.test.ts |
| P5 | The trail holds a granted value | Never. The trail holds field names, ids and the purpose, not values | tests/trail.test.ts |
| P6 | An MCP agent lists the fields | It does not see `private` fields at all | tests/mcp.test.ts |
| P7 | A grant says "smaller answers" (`derive`) | The resolver gets `derive: true`. A field with no smaller form comes back as it is, and the approval page says which fields have one | tests/resolvers.test.ts, tests/read.test.ts |
| P8 | A resolver returns more than 256 KB | `read` fails with `resolver-failed` | tests/resolvers.test.ts |

## Consent and grants

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| G1 | A read on an expired grant, also when it expires while the notice or the resolver runs | `expired`, and no values. The grant is checked again after the resolver answers, right before the values are returned | tests/read.test.ts, E2E |
| G2 | A read on a revoked grant, also when the revoke comes while the notice or the resolver runs | `revoked`, and no values | tests/read.test.ts, E2E |
| G3 | A read asks for a field that the grant does not hold | `field-not-granted` | tests/read.test.ts |
| G4 | A read on an unknown grant id, or on a grant of another agent | `no-grant`. The two look the same, so an agent cannot probe other grants. No trail entry, so a page cannot flood the trail with guesses | tests/read.test.ts, tests/mcp.test.ts |
| G5 | The clock goes back | foxscope keeps the latest time it saw, so an expired grant stays expired | tests/read.test.ts |
| G6 | The approval page shows one request and another one is approved | `approve` takes the digest the page showed. A different digest fails with `request-changed` | tests/approve.test.ts |
| G7 | An agent changes the fields or the purpose after an approval | It is a new request and needs a new approval. A grant covers only its own fields and purpose | tests/approve.test.ts |
| G8 | A standing rule covers only some of the fields | `pending` for the whole request, not a part grant | tests/rules.test.ts |
| G9 | A rule allows a longer time than the request asks, or the request asks more than the rule allows | The grant gets the shorter of the two | tests/rules.test.ts |
| G10 | A rule for agent A meets a request from agent B | No match. Agent names match exactly; there is no wildcard agent | tests/rules.test.ts |
| G11 | A rule glob such as `**` covers every namespace | Refused with `bad-rule`. A glob starts with a fixed namespace | tests/fields.test.ts, tests/rules.test.ts |
| G12 | A request waits longer than 10 minutes | It expires. `approve` fails with `expired`; `pending()` does not show it | tests/approve.test.ts |
| G13 | A request is approved twice, or approved after a deny | `not-found`. A decision removes the request | tests/approve.test.ts |
| G14 | The user revokes an agent | Its grants are revoked, its pending requests are dropped, and its standing rules are removed, so the next request asks again | tests/rules.test.ts |
| G15 | `approve` gets a time over 30 days | `bad-ttl` | tests/approve.test.ts |
| G16 | The user removes a standing rule, and the grants it made stay live until they expire (up to the rule's longest time) | Removing a rule revokes every live grant that the rule made. The trail entry counts them. Grants the user approved stay | tests/rules.test.ts |
| G17 | Any https page gets every `public` field at once, with no approval window, for as long as it asks | A scope grants `public` fields without asking only when it is made with `grantPublic: true`. The CLI and the MCP server (local agents the user starts) set it; the extension does not, so a web page gets nothing without an approval or a standing rule | tests/request.test.ts, tests/cli.test.ts, E2E |
| G18 | A web page gets a grant for up to 30 days, from one click or one rule | A scope made with `maxGrantSeconds` gives no grant longer than that: a longer ask is cut to the cap, an approval or a rule over it is refused (`bad-ttl`, `bad-rule`). The extension sets 1 hour for pages, and its approval page and rule form offer nothing longer | tests/approve.test.ts, E2E |

## Trail

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| T1 | An action leaves no trace | Each request, refusal, grant, denial, read, refused read, revoke and rule change adds one foxtrail entry | tests/trail.test.ts |
| T4 | A grant entry does not say who got the grant or why. For a rule or a public grant the actor is `rule` or `public`, and the purpose never reaches the trail | Each `scent.grant` entry holds the agent and the purpose, whoever granted it | tests/trail.test.ts |
| T5 | The README says a page cannot fill the trail, which is true only for guessed grant ids | The README states the real bound: through requests one site adds at most 31 entries a minute (30 requests and one rate-limit refusal); a site with a grant adds one entry, and one notice, per read of it, with no limit; a guessed grant id adds none | tests/trail.test.ts |
| T2 | The trail cannot be written | The action fails and returns no values. foxscope writes the trail before it reads a value | tests/trail.test.ts |
| T3 | Someone edits the trail | `verifyTrail()` returns `ok: false` with the index of the first bad entry | tests/trail.test.ts, E2E |

## Notice

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| N1 | The notice callback throws | The read fails with `notice-failed` and returns no values. A read the user cannot see does not happen | tests/read.test.ts |
| N2 | An agent reads in the browser | One browser notification per read, and the read shows in the manager page | E2E |

## Resolvers

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| R1 | Two resolvers have the same namespace | `createScope` throws `bad-resolvers` | tests/resolvers.test.ts |
| R2 | A resolver throws in `list` or `read` | `denied` `resolver-failed: <namespace>` on a request, `resolver-failed` on a read. Other namespaces still work | tests/resolvers.test.ts |
| R3 | A resolver never answers | It fails after 5 s with `resolver-failed` (timeout) | tests/resolvers.test.ts |
| R4 | A resolver returns a field list in the wrong shape | `resolver-failed`; foxscope does not guess | tests/fields.test.ts |
| R5 | foxprefs or foxpack is not installed | The CLI and the MCP server run without it and say "not installed". The extension says the same when `runtime.sendMessage` fails | tests/node.test.ts, E2E |
| R6 | foxprefs is installed but has no `prefsResolver` export | The CLI stops with a message that names the package | tests/node.test.ts |

## Store

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| S1 | `state.json` is not JSON, or has the wrong shape or version | `corrupt-store` with the path. foxscope does not overwrite it | tests/state.test.ts, tests/node.test.ts |
| S2 | The CLI approves while the MCP server writes | A lock file orders the writers, so no change is lost | tests/node.test.ts |
| S3 | The process stops in the middle of a write | foxscope writes a temp file and renames it, so `state.json` is always whole | tests/node.test.ts |
| S4 | A crashed process leaves the lock file | After 10 s the next writer takes the lock | tests/node.test.ts |
| S6 | A slow resolver (up to 5 s per call) keeps a process inside the lock until another process counts the lock as stale, takes it, and saves a revoke or a rule removal. The first process then saves the state it loaded before, and the revoke is undone | No resolver call or notice runs under the lock. A request, a read and an approval ask the resolvers between two locked steps; the second step loads the state again and checks it again (the grant, the rule, the waiting request), so a revoke, a rule removal or a deny that came meanwhile holds | tests/lock-race.test.ts |
| S7 | A stored date is not a time (for example `expiresAt: "garbage"`). `Date.parse` gives NaN, every `<=` check is false, and an expiry check lets the grant through | Each date in the state must be an exact ISO time (`toISOString()` gives it back), and every other field must have its type, when the store loads. Anything else is `corrupt-store`, and nothing is read | tests/state.test.ts |
| S5 | `FOXSCOPE_HOME` is not set | `~/.foxscope`, made with mode 0700. The files have mode 0600 | tests/node.test.ts |

## CLI and MCP server

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| C1 | An unknown command or a missing argument | Usage on stderr, exit 2 | tests/cli.test.ts |
| C2 | A command fails (`not-found`, `corrupt-store` ...) | The code and the message on stderr, exit 1 | tests/cli.test.ts |
| C3 | The user approves an id without knowing what it is | `approve` prints the agent, the fields and the purpose it approved. `pending` shows them first | tests/cli.test.ts |
| C4 | An agent tells the user to run `foxscope approve <id>`, and the user approves whatever the agent said it was | `approve` first prints the whole request: agent, fields, purpose, time and the first 12 characters of its digest. At a terminal it asks `[y/N]`; anything but yes grants nothing. Without a terminal it grants only with `--yes --digest <those 12 characters>`. The approval is bound to the full digest it showed (`request-changed` otherwise) | tests/cli.test.ts |
| C5 | An agent name or a purpose holds bidi or invisible characters (U+202E, U+200B ...), so the terminal shows the user something other than what the request holds | The CLI prints control, bidi and invisible characters in the agent, the purpose, a field label and the trail as `\u{...}` escapes, as the approval page does | tests/cli.test.ts |
| M1 | The MCP client sends no name | Every tool refuses: foxscope needs a name to scope the grants | tests/mcp.test.ts |
| M2 | An MCP agent reads or revokes the grant of another agent | `no-grant` | tests/mcp.test.ts |
| M3 | A request waits for the user | The tool result names the exact command: `foxscope approve <id>` | tests/mcp.test.ts |
| M4 | A local program claims the MCP client name of another agent (stdio has no way to prove who the client is) | foxscope cannot stop it. Grants and rules are bound to the name the client reports, so the program gets that name's grants and rules. The README says so, the pending result tells the user which name the agent gave and that foxscope cannot check it, and `approve` shows that name before it asks | tests/mcp.test.ts |

## Extension and web pages

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| E1 | A hostile page passes getters, proxies or odd types to `window.scent.request` | The content script copies plain data only, checks it, and rejects anything else | E2E |
| E2 | A page claims to be another agent | The agent is the page origin that Firefox reports for the sender. The page cannot set it | E2E |
| E3 | A page reads a grant of another origin | `no-grant` (G4) | E2E |
| E4 | A page asks for a private field | Refused at once. No approval page opens (P1) | E2E |
| E5 | A page opens, frames or clicks the approval page | The extension pages are not web accessible. Only a click in the extension approves | manifest has no `web_accessible_resources` |
| E6 | The event page unloads while a request waits | The request is in `storage.local`. After the approval, the background sends the answer to the tab that asked | E2E |
| E7 | foxprefs or foxpack answers in the wrong shape | That resolver fails (R4); the manager says so | tests/extension.test.ts |
| E8 | An iframe on the page calls the API | The API is in the top frame only | manifest `all_frames: false` |
| E9 | A page reads the refusal reason. `private-field: x` and `unknown-field: x` tell it which private fields the user has; `resolver-failed: memory` tells it which add-ons are installed | A page gets one refusal for everything: `denied`, as a request answer and as a thrown error, a user's deny included. The reason goes to the trail, which the manager page shows. A `pending` answer still tells a field the user has from one they do not have (E12) | tests/extension.test.ts, E2E |
| E10 | The sample values are on by default, so every new install answers pages with made-up data the user never chose | The demo data is off on a fresh install. The user turns it on in the manager page | E2E |
| E11 | A page opens the approval window under the user's pointer, and a click aimed at the page lands on Approve | Approve and Approve smaller answers stay disabled until 1 s after the window is shown or gets focus, and go back to disabled when it loses focus. A click before that does nothing. Deny works at once | E2E |
| E12 | A page learns which fields and add-ons the user has from the answer it gets | Not prevented, and said in the listing and the README. A field the user has gives `pending` and an approval window; a missing field, a private field or a field of an add-on that is not installed gives `denied` at once. A page cannot tell these three apart, and gets no value without an approval. Answering `pending` for all of them would not hide it: the approval window, the timing, the same `requestId` for a repeat and the waiting limit per site would still differ | tests/extension.test.ts |

## Release

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| X1 | A release publishes to npm and AMO without running the Firefox E2E | release.yml runs the E2E on Ichabod (secret `ICHABOD_API_KEY`) and `ci:local` first; npm publish needs both, and the AMO submission needs npm publish | tests/release.test.ts |
| X2 | Every release step, `pnpm install` included, runs with `contents: write` and `id-token: write` | The workflow grants nothing by default. Each job gets only what it needs: `id-token: write` only in the npm publish job, `contents: write` only in the job that creates the GitHub release | tests/release.test.ts |
| X3 | A dependency's install script in the npm publish job asks for the OIDC token, or a changed cloudflared binary runs in the E2E job that holds `ICHABOD_API_KEY` | The check job builds `dist/` and `dist-ext/` and uploads them; the npm job downloads that build and runs `npm publish --ignore-scripts` with no install and no build, and the AMO job submits the same `dist-ext/`. The E2E job checks cloudflared against a pinned sha256 before it runs it | tests/release.test.ts |
