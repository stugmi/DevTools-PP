# Network requests

Inspect completed requests in a newest-first list with a separate detail view.

## List and selection

Filter by domain, resource type, method, and minimum or maximum duration. Files and Network keep independent list selections. Changing filters keeps a matching selected request highlighted and brings it into view.

Right-click a request for **Open in new tab** or **Copy address**, which use its full URL.

## Detail views

Selecting a request opens **Headers**, **Payload**, **Preview**, **Response**, **Cookies**, and **Timing** views, where applicable.

- **Raw** switches headers between parsed and wire-oriented text.
- **Source** shows highlighted, optionally pretty-formatted body text.
- **Parsed** shows a collapsible JSON tree or HTML/XML document tree.
- **Preview** displays HTML, SVG, and images in a sandboxed frame with scripts disabled.

Use the [keyboard shortcuts](editor.md#keyboard-shortcuts) to move between requests and detail tabs.

## Content loading

Response content is requested from the DevTools cache only when **Response** or **Preview** is opened, or the request is exported. Socket streams retain handshake metadata without reading an unbounded streaming body.

For the data included in saved requests, see [request snapshots](exporting.md#request-snapshots). Capture visibility and navigation behavior are described in [capture and filtering](usage.md).
