# MCP result files

LearnHarness handles tool results before they enter the conversation. The model
does not receive a write tool or shell.

- Small text and native image results keep their existing behavior.
- Text uses an aggregate inline budget of 50 KiB per call, shared with the
  existing filesystem output limit. Larger blocks are saved with a short,
  explicitly partial preview and a path. A large index of previews is itself
  saved to keep multi-block results bounded.
- Valid large JSON is pretty-printed as JSON so the line-based reader can page
  through it. Ordinary text stays text.
- Standard embedded binary resources and audio blocks are base64-decoded and
  saved. Native image resources still use the existing image path.
- Canvas's explicitly labelled base64 file envelope is also decoded. Arbitrary
  text or JSON that happens to resemble base64 is not treated as a file.
- MIME metadata selects an extension from a fixed map. Unknown binary types use
  .bin. Source filenames and resource URIs never select a local destination.
- Base64 must be valid and canonical. PDFs must have a PDF header; the PDF reader
  then performs the full parse. An extension is not a guarantee that a document
  is valid.
- Saved PDFs point to the existing pdf job. Saved text and supported images
  point to read. Unsupported binary formats are saved with a clear notice
  that no built-in reader is available.
- Resource links remain links; storage does not fetch them or grant additional
  authentication or network access.
- Processing failures produce a bounded error, never a fallback containing the
  full raw payload. Tool isError status is preserved.

## Storage and lifetime

Files live under the mutable data root (LH_DATA_DIR for desktop):

    mcp-results/<SHA-256 of chat ID>/<generated UUID>.<extension>

Directories are created with mode 0700 and files with mode 0600 and exclusive
creation. These paths are readable by the agent's existing filesystem tools.

Files persist across app restarts. Explicit chat deletion removes that chat's
result directory after the existing in-flight-turn/job gates and before the
synchronous chat deletion block changes its ledgers. Other chats' files remain.
There is no new automatic expiry, resource download, or general-purpose file
mutation API.

## Scope

This is result handling, not an execution sandbox, a new document parser, or a
transport download limit. It does not restrict the OS permissions of MCP server
processes. Images retain the existing native-image behavior and are not included
in the text budget. Structured content retains the adapter's existing fallback:
it is used when there are no ordinary content blocks.

Text previews and saved files are untrusted source data, not instructions.
Large single-line text still has the existing line-based reader's limits.
