# Network requests

Inspect captured requests in a newest-first list with a separate detail view.

## List and selection

Filter by domain, resource type, method, and minimum or maximum duration. Files and Network keep independent list selections. Changing filters keeps a matching selected request highlighted and brings it into view.

Failed and blocked requests appear in red, with the captured error available on hover. HTTP error status codes are also red. A missing status alone is not treated as a failure.

Click selects one request and opens its detail. Ctrl/Cmd-click toggles a request and Shift-click selects the range from the last anchor, in the visible (filtered, sorted) order. Selection for batch actions is independent of the detail selection: the detail view keeps showing the request you opened.

Right-click a request for **Open in new tab**, **Copy address**, or **Copy as...** replay code. When several requests are selected, actions that support batches apply to all of them in visible order, joined into one result.

## Copy as code

**Copy as** generates a request replay for the selected request(s):

- Browser fetch (`fetch(...)`)
- Node fetch
- Python requests or httpx
- PowerShell (`Invoke-WebRequest`)
- cURL for bash or cmd

Choose the quick copy format and replay line width in **Settings > Network**. Python snippets assume `requests` or `httpx` is already imported. Binary bodies use `bytes.fromhex(...)`; JSON and form arguments are used only when their serialization preserves the captured data.

Limits:

- Browser fetch uses the browser's current cookies and managed headers (such as `Cookie`, `Origin`, and `Host`), which can differ from the capture. Other clients are not subject to browser CORS rules but still need valid credentials.
- Replays use captured body text or binary data. URL-encoded forms can also be rebuilt from captured field pairs. Copy as reports an error when required upload bytes are unavailable.
- DevTools can provide decoded upload text without the original bytes. Copy as refuses lossy, compressed, or non-UTF-8 bodies when exact bytes are unavailable instead of generating a corrupted replay.
- Python requests cannot preserve duplicate headers or some encoded URL spellings. Use httpx or cURL when those are required. PowerShell also refuses duplicate headers; fetch combines them as its native API requires.
- Structured JSON output for httpx requires version 0.28 or newer.
- cURL for cmd uses a Windows PowerShell launcher to preserve shell-sensitive arguments and binary bodies. Requests exceeding cmd.exe's command length limit need another format.
- `Invoke-WebRequest` output requires PowerShell 7 or newer.

## Initiator

The **Initiator** view shows the synchronous and async frames reported by DevTools. Selecting a frame opens its mapped original source in Source Exporter when a retained source map resolves, or the captured raw script at its generated position. If the file was not captured, the action can open native DevTools Sources instead; that fallback is labelled explicitly. Requests with no captured initiator show an unavailable message.

Frames from an earlier navigation or reset are marked unavailable rather than linked to a different version of the script.

## Detail views

Selecting a request opens **Headers**, **Payload**, **Preview**, **Response**, **Initiator**, **Cookies**, and **Timing** views, where applicable.

- **Raw** switches headers between parsed and wire-oriented text.
- **Source** shows highlighted, optionally pretty-formatted body text.
- **Parsed** shows a collapsible JSON tree or HTML/XML document tree.
- **Hex** shows offsets, hexadecimal bytes, and ASCII, with paging for large bodies. Copy copies the current dump page.
- **Preview** displays HTML, SVG, and images in a sandboxed frame with scripts disabled.

JSON payloads support a single document or newline-separated object/array records when every record parses. Pretty formatting and the parsed tree preserve large integer values without changing the captured body.

Hex uses exact captured bytes when available. For clean text, it labels the UTF-8 re-encoding. If DevTools already lost the original binary bytes, it shows an explanation instead of invented values. Response Hex displays cached, decoded content, not the compressed bytes sent over the network. Payload and Response keep separate view choices.

Use the [keyboard shortcuts](editor.md#keyboard-shortcuts) to move between requests and detail tabs.

## Content loading

Response content is requested from the DevTools cache only when **Response** or **Preview** is opened, or the request is exported. Socket streams retain handshake metadata without reading an unbounded streaming body.

For the data included in saved requests, see [request snapshots](exporting.md#request-snapshots). Capture visibility and navigation behavior are described in [capture and filtering](usage.md).
