# What the foxscope add-on gives out, and its AMO data declaration

The manifest declares `data_collection_permissions: { "required": ["none"] }`.
This page lists everything the add-on in `extension/` hands out, and why we
chose `none`. The choice is a judgement call; read "Open question" below.

## What leaves the add-on

| What | To whom | When | Network request by the add-on |
|---|---|---|---|
| The values of approved fields, for example a top size or a budget band | The web page that asked, in the same tab | Only after the user approves that page's request in the approval window, or adds a standing rule for that page. This holds for `public` fields too: the extension's scope does not set `grantPublic`. A grant lasts at most 1 hour (`PAGE_MAX_GRANT_SECONDS`) | None. The values go to the page through `window.scent`, inside the browser |
| The word `denied` | A page whose request or read is refused | Each refusal. The reason (a private field, a missing add-on) stays in the trail | None |
| A notification per read | Nobody. Firefox shows it on this computer | Each read | None |
| `scent.list` and `scent.read` messages | The foxprefs and foxpack add-ons, when installed | When foxscope needs their fields | None. `runtime.sendMessage` stays in the browser |

The add-on makes no network request. It has no server, no analytics and no
error reports. The trail stays in the add-on's IndexedDB.

## Why `none`

AMO's add-on policies define data transmission as data "collected, used,
transferred, shared, or handled outside of the add-on or the local browser".
foxscope itself never moves data outside the local browser: it gives a value
to a page in the same browser, and only after the user approves that exact
request (fields, purpose and time) or sets a standing rule for that page.
No field reaches a page without one of those two, the fields marked `public`
included, and no grant lasts longer than 1 hour. The demo data, made-up
values, is off until the user turns it on. Tests: G17 and G18 in
`docs/failure-modes.md`, and the E2E.

## Open question

A page that gets a value can send it to its own server. Whether AMO counts
"hands user data to a web page on the user's approval" as a transmission by
the add-on is not settled here. If a reviewer says it does, the honest
declaration is optional data types matching the fields that foxprefs and
foxpack expose (for example `personallyIdentifyingInfo` and
`financialAndPaymentInfo`), asked with Firefox's built-in consent before the
first grant. That change must update the manifest, this page and the listing
together.
