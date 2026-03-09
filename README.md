# obsidian-to-x-publisher

> 日本語版は[README-JP.md](README-JP.md)をご覧ください。

Automatically publish Obsidian Markdown notes to X (Twitter) Articles.

- No DOM manipulation — calls X's internal GraphQL API directly
- Image upload with automatic compression for files over 5 MB
- Inline styles: Bold, Italic, Strikethrough
- Obsidian plugin + local server architecture

## How It Works

```text
Obsidian command
  → POST http://127.0.0.1:3001/publish
    → ArticleEntityDraftCreate  (create article, get ID)
    → ArticleEntityUpdateTitle  (set title)
    → upload2.json INIT/APPEND/FINALIZE/STATUS  (upload images)
    → ArticleEntityUpdateContent  (send DraftJS content_state)
  → Write x_url / x_status: published back to Frontmatter
```

## Installation

### Obsidian Plugin via BRAT

Install the plugin directly from GitHub using [BRAT](https://github.com/TfTHacker/obsidian42-brat).

1. Install and enable BRAT in Obsidian
2. Open the command palette → "BRAT: Add a beta plugin"
3. Enter the repository URL:

   ```text
   https://github.com/shimayuz/obsidian-to-x-publisher
   ```

For the full walkthrough, see [docs/brat-setup.md](docs/brat-setup.md).

### Local Server

```bash
git clone https://github.com/shimayuz/obsidian-to-x-publisher.git
cd obsidian-to-x-publisher
npm install
npx playwright install chromium

# Start the server (port 3001)
npm run server
```

Set session cookies via the Obsidian plugin settings (manual DevTools entry or Chrome login).

For details, see [docs/setup-and-usage.md](docs/setup-and-usage.md).

## Supported Markdown Elements

| Markdown | X Articles |
| -------- | ---------- |
| `## Heading` | Large heading |
| `### Heading` | Small heading |
| `**bold**` | Bold |
| `*italic*` | Italic |
| `~~strike~~` | Strikethrough |
| `- item` | Bullet list |
| `1. item` | Numbered list |
| `> quote` | Blockquote |
| `` ```code``` `` | Code block |
| `---` | Divider |
| `![[image.png]]` | Image (auto-uploaded) |

Inline code (`` `code` ``) is not supported by the X Articles API and falls back to plain text.

## Image Upload

- Endpoint: `upload2.json` (v2, same as the browser)
- Files over 5 MB are automatically compressed using macOS's built-in `sips` (JPEG, max 2048 px)
- No external dependencies required

## Project Structure

```text
src/
  x-api-publisher.js   # GraphQL API + image upload + Markdown conversion
  server.js            # Express server (port 3001)
scripts/
  capture-api.js       # Browser API capture (for debugging)
plugin/                # Obsidian plugin source
docs/                  # Documentation
```

## npm Scripts

| Command | Description |
| ------- | ----------- |
| `npm run server` | Start the server (port 3001) |
| `npm run capture-api` | Capture browser API traffic (for debugging) |

## Documentation

- [BRAT Setup](docs/brat-setup.md) — Install the Obsidian plugin via BRAT
- [Setup & Usage](docs/setup-and-usage.md) — Installation, server startup, troubleshooting
- [API Reference](docs/api-reference.md) — X Articles GraphQL API specification
- [Image Upload Process](docs/image-upload-process.md) — INIT/APPEND/FINALIZE/STATUS flow, sips compression
- [Markdown → DraftJS Mapping](docs/markdown-draftjs-mapping.md) — Conversion reference

## Notes

- `x-cookies.json` is never committed (already in `.gitignore`)
- macOS only (requires `sips` for image compression)
- May break if X changes its internal API
