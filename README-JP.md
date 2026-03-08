# obsidian-to-x-publisher

> [English version (README.md)](README.md)

ObsidianのMarkdownノートをX (Twitter) Articlesへ自動投稿するツール。

- Playwright DOM操作なし → X の内部GraphQL APIを直接呼び出し
- 画像アップロード・5MB超え自動圧縮・インラインスタイル対応
- Obsidianプラグイン + ローカルサーバー構成

## 動作フロー

```text
Obsidian コマンド
  → POST http://127.0.0.1:3001/publish
    → ArticleEntityDraftCreate  (記事作成・ID取得)
    → ArticleEntityUpdateTitle  (タイトル設定)
    → upload2.json INIT/APPEND/FINALIZE/STATUS  (画像アップロード)
    → ArticleEntityUpdateContent  (本文 DraftJS content_state 送信)
  → Frontmatter に x_url / x_status: published を書き戻し
```

## インストール

### Obsidian プラグイン（BRAT 経由）

[BRAT](https://github.com/TfTHacker/obsidian42-brat) を使って Obsidian に直接インストールできます。

1. BRAT をインストール・有効化
2. コマンドパレット →「BRAT: Add a beta plugin」
3. URL を入力: `https://github.com/shimayuz/obsidian-to-x-publisher`

詳細は [docs/brat-setup.md](docs/brat-setup.md) を参照。

### ローカルサーバー

```bash
git clone https://github.com/shimayuz/obsidian-to-x-publisher.git
cd obsidian-to-x-publisher
npm install
npx playwright install chromium

# X にログインして Cookie を保存（初回のみ）
npm run login

# サーバー起動（port 3001）
npm run server
```

詳細は [docs/setup-and-usage.md](docs/setup-and-usage.md) を参照。

## 対応Markdown要素

| Markdown | X Articles |
| -------- | ---------- |
| `## 見出し` | 大見出し |
| `### 見出し` | 小見出し |
| `**太字**` | Bold |
| `*斜体*` | Italic |
| `~~打ち消し~~` | Strikethrough |
| `- リスト` | 箇条書き |
| `1. リスト` | 番号付きリスト |
| `> 引用` | 引用 |
| `` ```code``` `` | コードブロック |
| `---` | 区切り線 |
| `![[image.png]]` | 画像（自動アップロード） |

インラインコード（`` `code` ``）はX Articles API非対応のためプレーンテキストに変換。

## 画像アップロード

- エンドポイント: `upload2.json`（v2、ブラウザと同じ）
- 5MB超えの場合: macOS組み込みの`sips`で自動圧縮（JPEG変換・最大2048px）
- 外部ライブラリ不要

## ファイル構成

```text
src/
  x-api-publisher.js   # GraphQL API + 画像アップロード + Markdown変換
  server.js            # Express サーバー (port 3001)
scripts/
  login.js             # 初回ログイン・Cookie保存
  capture-api.js       # ブラウザAPIキャプチャ（調査用）
plugin/                # Obsidian プラグイン本体
docs/                  # 詳細ドキュメント
  MoC-obsidian-to-x-publisher.md
  api-reference.md
  image-upload-process.md
  markdown-draftjs-mapping.md
  setup-and-usage.md
  brat-setup.md
```

## npm scripts

| コマンド | 内容 |
| ------- | ---- |
| `npm run login` | 初回ログイン・Cookie保存 |
| `npm run server` | サーバー起動 (port 3001) |
| `npm run capture-api` | ブラウザAPIキャプチャ（調査用） |

## ドキュメント

- [BRAT セットアップ](docs/brat-setup.md) — BRAT 経由の Obsidian プラグインインストール手順
- [セットアップ・使い方](docs/setup-and-usage.md) — インストール・トラブルシューティング
- [API リファレンス](docs/api-reference.md) — X Articles GraphQL API 仕様
- [画像アップロードプロセス](docs/image-upload-process.md) — INIT/APPEND/FINALIZE/STATUS フロー・sips 圧縮
- [Markdown→DraftJS マッピング](docs/markdown-draftjs-mapping.md) — 変換仕様一覧

## 注意事項

- `x-cookies.json` はGitにコミットしない（`.gitignore`済み）
- macOS専用（sips画像圧縮のため）
- X Articles APIの仕様変更により動作しなくなる可能性あり
