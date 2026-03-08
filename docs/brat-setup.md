---
tags:
  - obsidian-to-x-publisher
  - brat
  - setup
  - obsidian
created: 2026-03-08
---

# BRAT でのインストール方法

[BRAT (Beta Reviewers Auto-update Tool)](https://github.com/TfTHacker/obsidian42-brat) を使うと、
Obsidian の公式コミュニティプラグイン一覧に載っていないプラグインを GitHub から直接インストールできます。

## 前提条件

- Obsidian がインストール済み
- BRAT プラグインが有効化済み（未導入の場合は下記手順を参照）

## Step 1: BRAT をインストール

1. Obsidian の設定 → コミュニティプラグイン → 閲覧
2. 「BRAT」で検索 → インストール → 有効化

## Step 2: このプラグインを BRAT 経由で追加

1. コマンドパレット（`Cmd+P`）→「BRAT: Add a beta plugin」
2. リポジトリ URL を入力:

   ```text
   https://github.com/shimayuz/obsidian-to-x-publisher
   ```

3. 「Add Plugin」→ インストール完了後、設定 → コミュニティプラグイン で「X Article Publisher」を有効化

## Step 3: ローカルサーバーをセットアップ

プラグインは Obsidian 側の UI のみです。実際の投稿処理はローカルサーバーが担います。

```bash
# リポジトリをクローン
git clone https://github.com/shimayuz/obsidian-to-x-publisher.git
cd obsidian-to-x-publisher

# 依存パッケージをインストール
npm install
npx playwright install chromium

# X にログインして Cookie を保存（初回のみ）
npm run login

# サーバーを起動（投稿のたびに起動しておく必要あり）
npm run server
```

## Step 4: Obsidian プラグイン設定

1. 設定 → X Article Publisher
2. サーバー URL: `http://127.0.0.1:3001`（デフォルトのまま）

## 使い方

1. 投稿したいノートを Obsidian で開く
2. Frontmatter にタイトルを設定（省略時は H1 またはファイル名を使用）:

   ```yaml
   ---
   title: "記事タイトル"
   ---
   ```

3. コマンドパレット →「X Article に投稿」
4. 完了後、Frontmatter に `x_url` と `x_status: published` が自動で書き込まれる

## アップデート

BRAT を使っていれば自動的に最新リリースへ更新されます。
手動で更新する場合: 設定 → BRAT → 「Check for updates」

## トラブルシューティング

詳細は [[setup-and-usage]] を参照。

| 症状 | 原因 | 対処 |
| ---- | ---- | ---- |
| 投稿コマンドが失敗する | サーバー未起動 | `npm run server` を実行 |
| 認証エラー | Cookie 期限切れ | `npm run login` を再実行 |
| サーバーが見つからない | ポート番号の不一致 | プラグイン設定の URL を確認 |
