---
tags:
  - obsidian-to-x-publisher
  - image-upload
  - x-articles-api
  - sips
created: 2026-03-08
---

# 画像アップロードプロセス

## エンドポイント

```
https://upload.x.com/i/media/upload2.json
```

> **v1 (`upload.json`) は使わない**: ブラウザが `upload2.json` を使用していることを DevTools で確認済み。
> ただし、5MB の上限は v2 でも同じ（画像の場合）。

## アップロードフロー

```
INIT → APPEND → FINALIZE (allow_async=true) → STATUS ポーリング
```

### 1. INIT

```http
POST https://upload.x.com/i/media/upload2.json
  ?command=INIT
  &total_bytes=<ファイルサイズ>
  &media_type=image/jpeg
  &media_category=DraftTweetImage

→ { "media_id_string": "2030614206391951362", ... }
```

### 2. APPEND

```http
POST https://upload.x.com/i/media/upload2.json
  ?command=APPEND
  &media_id=<media_id_string>
  &segment_index=0

Body: multipart/form-data (field name: "media")
```

### 3. FINALIZE

```http
POST https://upload.x.com/i/media/upload2.json
  ?command=FINALIZE
  &media_id=<media_id_string>
  &original_md5=<md5hex>
  &allow_async=true          ← ブラウザと同じ非同期モード

→ { "processing_info": { "state": "pending", "check_after_secs": 1 } }
```

### 4. STATUS ポーリング（非同期処理の場合）

FINALIZE レスポンスに `processing_info` がある場合のみ実施。

```http
GET https://upload.x.com/i/media/upload2.json
  ?command=STATUS
  &media_id=<media_id_string>

→ { "processing_info": { "state": "succeeded" } }
```

`state` が `succeeded` になるまで `check_after_secs` 秒待ってリトライ（最大 30回）。

## メディアカテゴリ

| 拡張子 | media_type | media_category | draftCategory |
|-------|-----------|----------------|---------------|
| `.jpg` / `.jpeg` | `image/jpeg` | `tweet_image` | `DraftTweetImage` |
| `.png` | `image/png` | `tweet_image` | `DraftTweetImage` |
| `.webp` | `image/webp` | `tweet_image` | `DraftTweetImage` |
| `.gif` | `image/gif` | `tweet_gif` | `DraftTweetGif` |

## 5MB 超え画像の自動圧縮（sips）

X Articles API は画像を **5MB (5,242,880 bytes)** に制限している。
macOS 組み込みの `sips` コマンドで自動的に JPEG 変換・圧縮する。

### 圧縮ロジック

```
元ファイル > 5MB ?
  Yes → sips で JPEG 変換（品質: 80% → 60% → 40% → 20%）
        5MB 未満になった時点で採用
        アップロード後、一時ファイルを削除
  No  → そのままアップロード
```

### sips コマンド

```bash
sips -s format jpeg \
     -s formatOptions <quality> \
     -Z 2048 \
     "<input.png>" \
     --out "/tmp/<basename>_xpub_compressed.jpg"
```

- `-Z 2048` : 長辺最大 2048px にリサイズ（アスペクト比維持）
- `-s formatOptions 80` : JPEG 品質 80%
- `--out` : 一時ファイルパス（アップロード後に自動削除）

### 実績

| 元ファイル | 元サイズ | 圧縮後 | 品質 |
|-----------|---------|-------|------|
| cursor-rules-4types.png | 7037KB (6.9MB) | 429KB | JPEG 80% |
| marketplace-howto.png | 7375KB (7.2MB) | 512KB | JPEG 80% |
| skill-4benefits.png | 7610KB (7.4MB) | 520KB | JPEG 80% |

## MEDIA entity の構造

アップロード完了後、content_state の `entity_map` に追加する:

```json
{
  "key": "0",
  "value": {
    "type": "MEDIA",
    "mutability": "Immutable",
    "data": {
      "entity_key": "<uuid v4>",
      "media_items": [
        {
          "local_media_id": 1,
          "media_category": "DraftTweetImage",
          "media_id": "2030614206391951362"
        }
      ]
    }
  }
}
```

対応する `blocks` エントリ:

```json
{
  "type": "atomic",
  "text": " ",
  "key": "abc12",
  "data": {},
  "entity_ranges": [{ "key": 0, "offset": 0, "length": 1 }],
  "inline_style_ranges": []
}
```
