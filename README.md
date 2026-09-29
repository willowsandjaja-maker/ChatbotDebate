# Dream Debate — real-file knowledge notes update

This update changes the "Knowledge Notes" feature so it works with actual PDF (or .txt)
files you drag in yourself, instead of picking from a hidden pre-loaded list.

## What changed
- The Knowledge Notes box on the setup screen is now a real file drop zone (like the
  System Prompt box already was). Drag 2 PDF/text files onto it, or click it to browse.
- Each file's text is extracted server-side (same mechanism as the System Prompt upload)
  and the REAL content goes straight into that bot's system prompt for the debate —
  nothing is pre-baked into the app anymore.
- `knowledge-notes.json` is no longer used at all. If you still have a copy of it in your
  project folder, you can safely delete it — nothing references it.

## Files in this update (all full-file replacements)
- prompts.js
- server.js
- public/index.html
- public/app.js
- public/styles.css

## How to install
1. Back up your current versions of those 5 files if you want a rollback path.
2. Copy these 5 files into your project, overwriting the old ones at the same paths.
3. Delete `knowledge-notes.json` from your project root if it's still there (optional cleanup).
4. Run `npm start` and open http://localhost:3000 — no new npm packages are needed.

## Using it
On the "Relationship Advice" topic's setup screens, you'll now see a "Knowledge Notes"
box under the System Prompt box. Drag (or click to browse for) any 2 PDF or text files
onto it — for example the knowledge-base PDFs from earlier — and their real content will
be woven into that bot's debate answers. The "Interpreting Dreams" topic is unchanged and
still only asks for a system prompt file.
