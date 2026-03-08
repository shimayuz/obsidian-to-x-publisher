---
tags:
  - obsidian-to-x-publisher
  - markdown
  - draftjs
  - reference
created: 2026-03-08
---

# Markdown → DraftJS 変換マッピング

## ブロック要素

| Markdown 記法 | DraftJS block type | 備考 |
|-------------|-------------------|------|
| 通常段落 | `unstyled` | 空行で区切られたテキスト |
| `## 見出し` | `header-one` | X Articles の「大見出し」 |
| `### 見出し` | `header-two` | X Articles の「小見出し」 |
| `# 見出し` | タイトルとして抽出 | 本文に含まれない |
| `- 項目` / `* 項目` | `unordered-list-item` | 各行が1ブロック |
| `1. 項目` | `ordered-list-item` | 各行が1ブロック |
| `> テキスト` | `blockquote` | 各行が1ブロック |
| ` ``` ～ ``` ` | `atomic` + `MARKDOWN` entity | `entity_map` に格納 |
| `---` / `***` | `atomic` + `DIVIDER` entity | |
| `![[image.png]]` | `atomic` + `MEDIA` entity | Obsidian 画像記法 |
| `![alt](path)` | `atomic` + `MEDIA` entity | 標準 Markdown 画像記法（ローカルのみ） |

## インライン書式

| Markdown | DraftJS style | 備考 |
|----------|--------------|------|
| `**text**` | `Bold` | Pascal Case（`BOLD` は Internal server error） |
| `*text*` | `Italic` | |
| `~~text~~` | `Strikethrough` | |
| `` `code` `` | なし（プレーンテキスト） | `CODE` は API エラー（422）→ フォールバック |

## Obsidian 特有の構文処理

| 記法 | 処理 |
|------|------|
| `![[image.png]]` | 画像アップロード後 MEDIA entity |
| `![[image.png\|200]]` | サイズ指定は無視、ファイル名のみ使用 |
| `[[wikilink]]` | プレーンテキストに変換（リンク無効） |
| `[[page\|alias]]` | alias テキストに変換 |
| Frontmatter (`---`) | タイトル・メタ情報として使用、本文除去 |

## Frontmatter の扱い

```yaml
---
title: "記事タイトル"    ← X Articles のタイトルに使用
x_status: published
x_url: https://x.com/...
---
```

タイトル優先順位: `frontmatter.title` > `# H1` > ファイル名

## コードブロック entity の構造

````markdown
```javascript
const x = 1;
```
````

→ `entity_map` に追加:

```json
{
  "key": "2",
  "value": {
    "type": "MARKDOWN",
    "mutability": "Mutable",
    "data": {
      "markdown": "```javascript\nconst x = 1;\n```"
    }
  }
}
```

## 非サポート機能

- リンク (`[text](url)`) → プレーンテキストに変換（X Articles API に link entity がない）
- 画像リンク (`![alt](https://...)`) → スキップ（ローカルファイルのみ対応）
- ネストリスト → 非対応（フラット化）
- テーブル → 非対応（プレーンテキスト化）
- インラインコード → プレーンテキスト（`CODE` style が API 非対応）
