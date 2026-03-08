---
tags:
  - MoC
  - obsidian-to-x-publisher
  - x-articles
created: 2026-03-08
---

# MoC: obsidian-to-x-publisher

> Obsidian Markdown を X (Twitter) Articles へ自動投稿するツールの開発ドキュメント集

## ドキュメント一覧

| ドキュメント | 内容 | タグ |
|------------|------|------|
| [[brat-setup]] | BRAT 経由の Obsidian プラグインインストール手順 | `#brat` `#setup` |
| [[setup-and-usage]] | ローカルサーバー起動・ログイン・投稿手順・トラブルシューティング | `#setup` |
| [[api-reference]] | X Articles GraphQL API 仕様・認証・レスポンス構造 | `#x-articles-api` |
| [[image-upload-process]] | 画像アップロードフロー・5MB 圧縮・STATUS ポーリング | `#image-upload` |
| [[markdown-draftjs-mapping]] | Markdown → DraftJS content_state 変換マッピング | `#markdown` `#draftjs` |

## プロジェクト概要

```
obsidian-to-x-publisher/
├── src/
│   ├── x-api-publisher.js   # メイン: GraphQL API + 画像アップロード + MD変換
│   └── server.js            # Express サーバー (port 3001)
├── scripts/
│   ├── login.js             # Playwright 認証 → x-cookies.json
│   └── capture-api.js       # ブラウザ API キャプチャ（調査用）
├── plugin/                  # Obsidian プラグイン本体
└── docs/                    # ← このディレクトリ
```

## 動作確認済み機能（2026-03-08）

- [x] 段落・見出し（##/###）・箇条書き・番号付きリスト
- [x] 引用・コードブロック・区切り線
- [x] 太字（`Bold`）・斜体（`Italic`）・取り消し線（`Strikethrough`）
- [x] 画像アップロード（INIT/APPEND/FINALIZE/STATUS）
- [x] 5MB 超え画像の自動圧縮（sips JPEG変換）
- [x] GraphQL サイレントエラー検出

## 関連リンク

- [[api-publisher]] - Claude セッション向け API 仕様メモ
