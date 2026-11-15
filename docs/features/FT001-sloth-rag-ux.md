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

### Phase 2 – Source viewer ✅

- [x] Store the full extracted text (and PDF page numbers) so the inspector shows the real document,
      not overlapping chunks; jump to the exact passage; "Page 4" / "Pages 2–3" / "Sheet Sales" labels.
      Passages are now exact slices of the document (`chunkSpans`) with stored start/end offsets.
- [x] SQLite schema v2 (`PRAGMA user_version`): `documents` table + `start_pos`/`end_pos`/`section` on
      chunks. Migrates v1 databases in place; old documents fall back to the passage view with a
      "re-add to see the whole document" note.
- [x] Light Markdown rendering (headings, lists, quotes, code) with the syntax dimmed, not removed, so
      highlight offsets stay exact. PDFs keep their line breaks.
- [x] Spreadsheets as tables: in results (matching rows first) and in the inspector (passage rows tinted).
- [x] Embeddings (transformers.js) moved into a Web Worker: indexing and search no longer freeze the page.
- [x] "Try with sample documents" (first run) / "Add sample documents" (library): five original docs in
      `public/samples` covering PDF, Word, Excel, text and Markdown, about one fictional company.
- [x] DuckDB tables persist: sheets are stored in SQLite and loaded into DuckDB the first time the SQL tab
      is opened (so the ~34MB DuckDB download only happens when someone actually wants SQL).

Notes from testing phase 2:
- 5 sample docs index in ~2s with the page fully responsive (cached model).
- "how many vacation days do I get" finds the handbook's "25 days of paid time off" with no word overlap.
- Markdown inline syntax (`**bold**`, links) is still shown raw.

### Phase 3 – Answers (RAG) ✅

- [x] In-browser LLM answers from the top passages with `[n]` citations: **Qwen3 0.6B** (q4f16 on WebGPU,
      ~570MB, int8 on WASM without WebGPU) in its own worker (`llm.worker.ts`), streamed token by token,
      with Stop / Regenerate. Opt-in: nothing downloads until "Enable answers".
- [x] Citations open the passage in the inspector; result cards show which `[n]` they are.
- [x] Answer sources are stricter than the result list (`answerCandidates`: close in meaning to the best
      hit, or a top-2 keyword match), overlapping passages of one document are merged into one continuous
      source, and a leading half-sentence is dropped (`buildSources`, `tidy`).
- [x] Spreadsheet questions: natural language → SQL (streamed into the editor, editable) → DuckDB, from the
      SQL tab or "Answer from q3-sales.xlsx with SQL" on the answer card. The reply is pre-started with
      "```sql SELECT", the prompt has worked examples on the sheet's own columns, the classic GROUP BY
      mistake is fixed in code (`fixGroupBy`), and other DuckDB errors get one repair round. Only
      SELECT/WITH queries run automatically.

Notes from testing phase 3 (Intel gen-9 integrated GPU, WebGPU with shader-f16):
- **Model choice was the hard part.**
  - Qwen2.5 0.5B/1.5B: activations overflow fp16, so q4f16 wrote garbage ("10 days/weeks/year/year/…");
    q4 (fp32) was correct but ~30s just to read the prompt.
  - Qwen3 1.7B (q4f16, 1.4GB): onnxruntime-web aborts while loading (out of WASM memory).
  - Qwen3 0.6B q4f16 works, `enable_thinking: false`.
- Qwen's `generation_config` sets `repetition_penalty: 1.1`, which also penalizes prompt tokens, so the
  model avoided copying facts from the sources. Forced to 1.0.
- Speed on that GPU: prompt reading ~25 tokens/s, generation ~4 tokens/s → 17–45s per answer
  (sources capped at 4 passages / 2,000 chars). A seconds counter shows it's alive.
- Quality: right on "how many vacation days do I get" (25 days [1]), "how much over budget is Kestrel"
  ($3,500), "which region had the highest revenue in September" (SQL → West, 88,000), "total deals per
  rep" (SQL + GROUP BY fix). Citations are sometimes skipped; the source chips are always shown.
- One model, one queue: writing SQL interrupts a running answer, but only between tokens, so it can
  wait for the answer's prompt reading to finish.

### Phase 4 – Keep and reuse

- [ ] Collections (separate indexes per workspace).
- [ ] Export / import the SQLite database file (backup, hand to a colleague).
- [ ] OCR for scanned PDFs (tesseract.js) – optional, very slow.

## Open questions

- ~~Which small LLM gives acceptable answers on WebGPU without a multi-GB download?~~ Qwen3 0.6B for
  now (see phase 3 notes). Worth retrying a 1–2B model with the external-data ONNX format (avoids the
  WASM memory abort), and offering it as "better answers" for machines with a discrete GPU.
- Should collections map to separate SQLite files or a `collection` column?
