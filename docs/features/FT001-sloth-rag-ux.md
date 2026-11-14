# FT001 – Sloth RAG UX plan 🦥

Turn the Sloth RAG demo (one long scrolling page) into a product people would actually use:
**ask questions about sensitive documents without uploading them anywhere.**

## Positioning

- **Who:** anyone who can't paste files into a cloud AI tool: legal, finance, HR, healthcare, security reviews.
- **Promise:** private (nothing leaves the machine), offline after first load, zero install, zero account.
- **Honest trade-off:** it's slow. Make the slowness tolerable: visible progress, background indexing, and
  persistence so you only pay the cost once per document.

## UX review of the demo (before this plan)

| # | Problem | Impact |
|---|---------|--------|
| 1 | Search is the 3rd thing on the page; the import log pushes it down, results push everything else down. | The main action is buried. |
| 2 | Result cards lead with a raw RRF score (`0.0328`) and rank numbers. | Reads like debug output. |
| 3 | No relevance cutoff: an unrelated doc at similarity 0.022 is shown like a real hit. | Users see junk and lose trust. |
| 4 | Storage falls back to in-memory silently (small gray text) when another tab holds the OPFS database. | Reload = data loss, unannounced. |
| 5 | Results are dead ends: no way to see the passage in its document. Markdown/CSV shown raw. | Can't verify an answer. |
| 6 | DuckDB SQL is a separate tool at the bottom, unconnected to the documents. | Spreadsheets feel bolted on. |
| 7 | Model downloads (~57MB first time) are a one-line status; no per-file progress; no drag-and-drop; the whole UI locks while busy. | Feels broken while it's working. |

## Target layout: three panes

```
┌─────────────┬──────────────────────────────┬────────────────────┐
│ LIBRARY     │  Ask your documents…    [⏎]  │ SOURCE / INSPECTOR │
│ [Drop files]│                              │ sloths.txt         │
│ ✓ sloths.txt│  ▸ sloths.txt                │ …They move very    │
│ ✓ notes.md  │    "Sloths are arboreal…     │ ▓slowly and spend▓ │
│ ⟳ q3.xlsx   │    They move very slowly"    │ most of their…     │
│ ✕ old.doc   │    [Open in source →]        │                    │
│             │                              │ ─ Details ─        │
│             │  ▸ 2 weak matches hidden     │ scores, embedding  │
│ 💾 Saved    │                              │ [Text | Table/SQL] │
└─────────────┴──────────────────────────────┴────────────────────┘
```

- **Left – Library:** drop zone, one row per file with its stage (queued → parsing → embedding → ready),
  errors inline on the row. Storage status lives here and is loud when nothing is being saved.
- **Centre – Ask:** one input; results grouped by document as clean snippets; weak matches folded away.
  Later: a generated answer with citations.
- **Right – Source / Inspector:** opens on a result or file click. Text docs: passages with the hit
  highlighted and scrolled into view. Spreadsheets: table view + SQL (DuckDB lives here now).
  Debug details (scores, ranks, embedding strip, extracted text) only in **Developer mode**.
- **Mobile:** the panes become three tabs (Library / Ask / Source).

## User workflow

1. **First visit:** empty state with a drop zone, "Try sample docs", and a one-line privacy promise.
   Model download shows real progress ("23MB, one time, then cached").
2. **Add sources:** drag files or a folder anywhere. Indexing runs in the background; you can search what's
   already ready. Everything persists locally.
3. **Ask:** results grouped by document with keyword + best-sentence highlights and "Open in source".
4. **Answer (the actual RAG):** an in-browser LLM writes an answer with `[1][2]` citations that open in the
   right pane. Spreadsheet questions → generated SQL.
5. **Keep and reuse:** collections ("Contracts", "Q3 finance"); export/import the database file.
6. **Developer mode:** one toggle reveals today's diagnostics so the demo value isn't lost.

## Phases

### Phase 1 – Layout pass ✅

- [x] Three-pane shell (library / ask / inspector), tabs on mobile; Sloth RAG becomes the home page,
      Sentiment moves to a small "demo" link.
- [x] Library: drop zone + drag-and-drop anywhere (files and folders), per-file stage and progress,
      errors/warnings on the row, remove a single document, two-click "Clear all".
- [x] Background indexing queue; search stays usable while files index.
- [x] Results grouped by document, relevance cutoff with "show weak matches", "Open in source".
- [x] Inspector: passages with the selected hit highlighted and scrolled into view; spreadsheet table
      preview + SQL; debug details behind Developer mode (remembered per browser).
- [x] Storage: loud banner when not persistent; multi-tab handling – a second tab waits for the database
      lock and offers **"Use here"**, which takes the database over from the other tab.
- [x] Embedding model download progress bar (pulled forward from phase 2).

Notes from testing phase 1:
- Embeddings run on the main thread, so the page freezes while indexing big files or embedding many
  sentences. Search now only embeds sentences of strong hits; moving transformers.js into a worker is phase 2.
- Result cutoff: semantic-only hits need similarity ≥ 0.3 (unrelated legal text scored 0.24–0.26).
- Import progress/errors live for the session only; after a reload the library shows what's in SQLite.
- Mobile tab layout built but not yet checked on a real phone-sized viewport.

### Phase 2 – Source viewer

- [ ] Store the full extracted text (and PDF page numbers) so the inspector shows the real document,
      not overlapping chunks; jump to the exact passage; "page 4" labels.
- [ ] Render Markdown; show spreadsheets as tables in results instead of CSV blobs.
- [ ] Move embeddings (transformers.js) into a Web Worker so the UI never freezes.
- [ ] "Try with sample docs" button.
- [ ] Persist DuckDB tables (re-load from stored sheets on startup).

### Phase 3 – Answers (RAG)

- [ ] In-browser LLM (WebGPU, small instruct model) answers from the top passages with `[n]` citations.
- [ ] Citations open the passage in the inspector.
- [ ] Spreadsheet questions: natural language → SQL (shown, editable) → DuckDB.

### Phase 4 – Keep and reuse

- [ ] Collections (separate indexes per workspace).
- [ ] Export / import the SQLite database file (backup, hand to a colleague).
- [ ] OCR for scanned PDFs (tesseract.js) – optional, very slow.

## Open questions

- Which small LLM gives acceptable answers on WebGPU without a multi-GB download?
- Should collections map to separate SQLite files or a `collection` column?
