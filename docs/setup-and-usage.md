---
tags:
  - obsidian-to-x-publisher
  - setup
  - usage
  - howto
created: 2026-03-08
---

# セットアップ・使い方

## 必要環境

- Node.js >= 16
- macOS（画像圧縮に `sips` を使用）
- X (Twitter) アカウント

## インストール

```bash
cd obsidian-to-x-publisher
npm install
npx playwright install chromium
```

## 初回ログイン（Cookie 取得）

```bash
npm run login
```

ブラウザが開くので X にログイン → 自動で `x-cookies.json` が生成される。

Cookie の有効期限が切れたら再実行。

## サーバー起動

```bash
npm run server
# → http://127.0.0.1:3001 で起動
```

常駐させる場合はターミナルを閉じないか、tmux / pm2 で管理する。

## Obsidian プラグイン設定

1. Obsidian の設定 → コミュニティプラグイン → 「X Article Publisher」
2. サーバー URL: `http://127.0.0.1:3001`
3. 投稿したいノートを開く
4. コマンドパレット → `X Article に投稿`

## ノートの Frontmatter

```yaml
---
title: "記事タイトル"         # 必須（なければ H1 またはファイル名）
x_status: draft               # draft / publishing / published
x_url: ""                     # 投稿後に自動設定
---
```

## 投稿フロー

```
Obsidian コマンド実行
  ↓
POST http://127.0.0.1:3001/publish
  ↓
x-api-publisher.js
  ├── ArticleEntityDraftCreate (記事ID取得)
  ├── ArticleEntityUpdateTitle (タイトル設定)
  ├── 画像アップロード × N枚
  │   ├── 5MB超え → sips で自動圧縮
  │   └── INIT → APPEND → FINALIZE → STATUS ポーリング
  └── ArticleEntityUpdateContent (本文設定)
  ↓
x_url と x_status: published を Frontmatter に書き込み
```

## エラー対処

| エラー | 原因 | 対処 |
|-------|------|------|
| `x-cookies.json が見つかりません` | 未ログイン | `npm run login` 実行 |
| `auth_token が見つかりません` | Cookie 期限切れ | `npm run login` 再実行 |
| `Upload INIT failed: maxFileSizeExceeded` | 5MB 超え（圧縮失敗） | sips が使えるか確認 |
| `Invalid article media (214)` | 画像エンティティ不正 | アップロード済み media_id を確認 |
| `GRAPHQL_VALIDATION_FAILED` | API スキーマ違反 | inline style 名を確認 |

## デバッグ・API 調査

```bash
# API キャプチャ（ブラウザの実際のリクエストを記録）
npm run capture-api

# x-api-publisher.js 単体テスト
node src/x-api-publisher.js
```
