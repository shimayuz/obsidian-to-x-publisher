---
tags:
  - obsidian-to-x-publisher
  - x-articles-api
  - graphql
  - reference
created: 2026-03-08
---

# X Articles API リファレンス

> capture-api.js による実測・動作確認済みの情報のみ記載

## 認証ヘッダー

```http
Authorization: Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA
Content-Type: application/json
x-csrf-token: <ct0 cookie value>
x-twitter-auth-type: OAuth2Session
x-twitter-active-user: yes
cookie: auth_token=...; ct0=...
```

## GraphQL エンドポイント

```
POST https://x.com/i/api/graphql/{queryId}/{operationName}
```

### 記事作成: `ArticleEntityDraftCreate`

- **queryId**: `4hFNtuxZcWaN3xZDBcarkw`
- **variables**: `{ content_state: { blocks: [], entity_map: [] }, title: "" }`
- **レスポンスから ID を取得**: `resp.data.*.result.rest_id` (base64 デコード不要、直接数値ID)

### タイトル更新: `ArticleEntityUpdateTitle`

- **queryId**: `vB7dx2puXvxv071SMcNBwg`
- **variables**: `{ articleEntityId: "<id>", title: "タイトル" }`

### 本文更新: `ArticleEntityUpdateContent`

- **queryId**: `S4R4uXKt_Vl1zmpYfBJYvQ`
- **variables**: `{ content_state: { blocks: [...], entity_map: [...] }, article_entity: "<id>" }`

## content_state 構造

```json
{
  "blocks": [
    {
      "key": "abc12",
      "type": "unstyled",
      "text": "本文テキスト",
      "data": {},
      "entity_ranges": [],
      "inline_style_ranges": [
        { "offset": 0, "length": 4, "style": "Bold" }
      ]
    }
  ],
  "entity_map": [
    {
      "key": "0",
      "value": {
        "type": "MEDIA",
        "mutability": "Immutable",
        "data": { "entity_key": "<uuid>", "media_items": [...] }
      }
    }
  ]
}
```

### block type 一覧（確認済み）

| type | 用途 |
|------|------|
| `unstyled` | 通常段落 |
| `header-one` | 大見出し（Markdown `##`） |
| `header-two` | 小見出し（Markdown `###`） |
| `unordered-list-item` | 箇条書き（`- item`） |
| `ordered-list-item` | 番号付きリスト（`1. item`） |
| `blockquote` | 引用（`> text`） |
| `atomic` | エンティティブロック（コード/画像/区切り線） |

### inline_style_ranges の style 名（確認済み・Pascal Case）

| style | Markdown |
|-------|----------|
| `"Bold"` | `**text**` |
| `"Italic"` | `*text*` |
| `"Strikethrough"` | `~~text~~` |
| ~~`"CODE"`~~ | 非サポート（422 エラー） → プレーンテキストにフォールバック |
| ~~`"BOLD"`~~ | 全大文字は Internal server error |

### entity_map の type 一覧（確認済み）

| type | mutability | data |
|------|-----------|------|
| `MARKDOWN` | `Mutable` | `{ "markdown": "```lang\n...\n```" }` |
| `DIVIDER` | `Immutable` | `{}` |
| `MEDIA` | `Immutable` | `{ "entity_key": UUID, "media_items": [{...}] }` |

## エラーハンドリング

### GraphQL サイレントエラー

**重要**: X Articles の GraphQL は HTTP 200 でも `errors[]` にエラーを返す。

```javascript
const resp = await graphqlPost(...);
if (resp.errors?.length) {
    throw new Error(`GraphQL error: ${JSON.stringify(resp.errors[0])}`);
}
```

よくあるエラーコード:
- `GRAPHQL_VALIDATION_FAILED` - スキーマ違反（非サポートの style など）
- `BadRequest: Invalid article media (214)` - 画像エンティティが無効
