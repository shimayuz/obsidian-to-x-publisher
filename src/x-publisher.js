#!/usr/bin/env node
/**
 * X Articles Playwright Publisher
 *
 * X (Twitter) Articlesエディタへ Markdown を自動転記
 * - Cookie 保存方式で認証
 * - リッチテキストエディタへ直接操作
 *
 * 使い方 (単体テスト):
 *   node src/x-publisher.js --debug
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

const COOKIES_PATH = path.join(__dirname, '../x-cookies.json');

// ========================================
// Markdown Parser
// ========================================

/**
 * Markdown を構造化ブロックに分解する
 * @param {string} markdown
 * @returns {Array<{type: string, content?: string, items?: string[], level?: number, fileName?: string}>}
 */
function parseMarkdownElements(markdown) {
    // Frontmatter を除去
    let content = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
    // タイトル（H1）を除去
    content = content.replace(/^#\s+.+\n?/, '');

    const elements = [];
    const lines = content.split('\n');
    let paragraphBuffer = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // 空行は段落区切り
        if (line.trim() === '') {
            if (paragraphBuffer.length > 0) {
                elements.push({ type: 'paragraph', content: paragraphBuffer.join('\n') });
                paragraphBuffer = [];
            }
            i++;
            continue;
        }

        // コードブロック
        if (line.startsWith('```')) {
            if (paragraphBuffer.length > 0) {
                elements.push({ type: 'paragraph', content: paragraphBuffer.join('\n') });
                paragraphBuffer = [];
            }
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            elements.push({ type: 'code', content: codeLines.join('\n') });
            i++; // 終了 ``` をスキップ
            continue;
        }

        // 見出し H2
        if (line.startsWith('## ') && !line.startsWith('### ')) {
            if (paragraphBuffer.length > 0) {
                elements.push({ type: 'paragraph', content: paragraphBuffer.join('\n') });
                paragraphBuffer = [];
            }
            elements.push({ type: 'heading', content: line.slice(3).trim(), level: 2 });
            i++;
            continue;
        }

        // 見出し H3
        if (line.startsWith('### ')) {
            if (paragraphBuffer.length > 0) {
                elements.push({ type: 'paragraph', content: paragraphBuffer.join('\n') });
                paragraphBuffer = [];
            }
            elements.push({ type: 'heading', content: line.slice(4).trim(), level: 3 });
            i++;
            continue;
        }

        // 区切り線
        if (line.match(/^---+$/) || line.match(/^\*\*\*+$/)) {
            if (paragraphBuffer.length > 0) {
                elements.push({ type: 'paragraph', content: paragraphBuffer.join('\n') });
                paragraphBuffer = [];
            }
            elements.push({ type: 'divider' });
            i++;
            continue;
        }

        // 引用ブロック（連続する > 行をグループ化）
        if (line.startsWith('>')) {
            if (paragraphBuffer.length > 0) {
                elements.push({ type: 'paragraph', content: paragraphBuffer.join('\n') });
                paragraphBuffer = [];
            }
            const quoteLines = [];
            while (i < lines.length && lines[i].startsWith('>')) {
                quoteLines.push(lines[i].replace(/^>[ ]?/, '').trim());
                i++;
            }
            elements.push({ type: 'quote', content: quoteLines.join('\n') });
            continue;
        }

        // 箇条書きリスト（連続する - / * 行をグループ化）
        if (line.match(/^[-*] /)) {
            if (paragraphBuffer.length > 0) {
                elements.push({ type: 'paragraph', content: paragraphBuffer.join('\n') });
                paragraphBuffer = [];
            }
            const items = [];
            while (i < lines.length && lines[i].match(/^[-*] /)) {
                items.push(lines[i].replace(/^[-*] /, '').trim());
                i++;
            }
            elements.push({ type: 'bulletList', items });
            continue;
        }

        // 番号付きリスト（連続する 1. 行をグループ化）
        if (line.match(/^\d+\. /)) {
            if (paragraphBuffer.length > 0) {
                elements.push({ type: 'paragraph', content: paragraphBuffer.join('\n') });
                paragraphBuffer = [];
            }
            const items = [];
            while (i < lines.length && lines[i].match(/^\d+\. /)) {
                items.push(lines[i].replace(/^\d+\. /, '').trim());
                i++;
            }
            elements.push({ type: 'numberedList', items });
            continue;
        }

        // Obsidian 画像: ![[image.png]] or ![[image.png|alt]]
        const obsidianImg = line.match(/^!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
        if (obsidianImg) {
            if (paragraphBuffer.length > 0) {
                elements.push({ type: 'paragraph', content: paragraphBuffer.join('\n') });
                paragraphBuffer = [];
            }
            elements.push({ type: 'image', fileName: obsidianImg[1].trim() });
            i++;
            continue;
        }

        // 標準 Markdown 画像: ![alt](path)
        const mdImg = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (mdImg && !mdImg[2].startsWith('http')) {
            if (paragraphBuffer.length > 0) {
                elements.push({ type: 'paragraph', content: paragraphBuffer.join('\n') });
                paragraphBuffer = [];
            }
            elements.push({ type: 'image', fileName: path.basename(mdImg[2]) });
            i++;
            continue;
        }

        // Wikiリンクを通常テキストに変換: [[page]] → page
        const processedLine = line
            .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (_, linkText) => linkText.trim());

        paragraphBuffer.push(processedLine.trim());
        i++;
    }

    // 最後のバッファをフラッシュ
    if (paragraphBuffer.length > 0) {
        elements.push({ type: 'paragraph', content: paragraphBuffer.join('\n') });
    }

    return elements;
}

/**
 * Frontmatter からタイトルを抽出
 * @param {string} markdown
 * @param {string} fileName
 * @returns {string}
 */
function extractTitle(markdown, fileName) {
    // Frontmatter の title フィールド
    const fmMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
        const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
        if (titleMatch) return titleMatch[1].trim();
    }

    // H1 見出し
    const h1Match = markdown.match(/^#\s+(.+)$/m);
    if (h1Match) return h1Match[1].trim();

    // ファイル名
    return fileName || '無題';
}

// ========================================
// Playwright Editor Operations
// ========================================

/**
 * X Articles の新規記事ページへ移動
 * @param {import('playwright').Page} page
 */
async function createNewArticle(page) {
    console.log('[Publisher] X Articles の新規記事ページへ移動...');

    // Articles の URL（複数試す）
    const articleUrls = [
        'https://x.com/i/articles/new',
        'https://twitter.com/i/articles/new'
    ];

    for (const url of articleUrls) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            break;
        } catch {
            // 次の URL を試す
        }
    }

    // ページが落ち着くまで待つ
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle').catch(() => {});

    // ログインリダイレクトを検出
    const currentUrl = page.url();
    console.log(`[Publisher] 現在のURL: ${currentUrl}`);
    if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login') || currentUrl.includes('/flow/')) {
        throw new Error('セッションが期限切れです。Obsidian 設定から再度「連携する」→ Cookie 設定を行ってください。');
    }

    // エディタのセレクター候補（X Articles の実装に合わせて複数試す）
    const editorSelectors = [
        '[contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        'div.DraftEditor-editorContainer [contenteditable="true"]',
        'div.public-DraftEditor-content',
        '[data-testid="article-editor"] [contenteditable="true"]',
        '[data-testid="article-body"]',
        '.notranslate[contenteditable="true"]'
    ];

    let foundSelector = null;
    for (const sel of editorSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: 10000, state: 'visible' });
            foundSelector = sel;
            console.log(`[Publisher] エディタ検出: ${sel}`);
            break;
        } catch {
            // 次のセレクターへ
        }
    }

    if (!foundSelector) {
        // デバッグ用スクリーンショットを保存
        const screenshotPath = `/tmp/x-publisher-debug-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        throw new Error(
            `エディタが表示されませんでした。\n` +
            `URL: ${page.url()}\n` +
            `デバッグ用スクリーンショット: ${screenshotPath}\n` +
            `Cookie が期限切れの可能性があります。再度「連携する」を実行してください。`
        );
    }

    await page.waitForTimeout(1000);
    console.log('[Publisher] エディタ準備完了');
}

/**
 * 記事タイトルを入力
 * @param {import('playwright').Page} page
 * @param {string} title
 */
async function setTitle(page, title) {
    console.log(`[Publisher] タイトル入力: "${title}"`);

    // タイトル入力エリアを探す（placeholder="Title" など）
    const titleSelectors = [
        '[data-testid="article-title"]',
        'textarea[placeholder*="Title"]',
        'textarea[placeholder*="タイトル"]',
        '[aria-label*="Title"]',
        '[aria-label*="タイトル"]',
        '[contenteditable="true"][aria-label*="Title"]'
    ];

    let titleInput = null;
    for (const selector of titleSelectors) {
        const el = page.locator(selector).first();
        if (await el.isVisible().catch(() => false)) {
            titleInput = el;
            break;
        }
    }

    if (titleInput) {
        await titleInput.click();
        await titleInput.fill(title);
    } else {
        // フォールバック: 最初の contenteditable をタイトルとして使用
        const firstEditable = page.locator('[contenteditable="true"]').first();
        await firstEditable.click();
        await firstEditable.fill(title);
    }

    await page.waitForTimeout(500);
}

/**
 * 本文エリアにフォーカスを移動
 * @param {import('playwright').Page} page
 */
async function focusBody(page) {
    // 本文エリア（タイトル以外の contenteditable）
    const bodySelectors = [
        '[data-testid="article-body"]',
        '[role="textbox"][aria-label*="Body"]',
        '[role="textbox"][aria-label*="本文"]'
    ];

    for (const selector of bodySelectors) {
        const el = page.locator(selector).first();
        if (await el.isVisible().catch(() => false)) {
            await el.click();
            return;
        }
    }

    // フォールバック: 2番目の contenteditable（タイトルの次）
    const editables = page.locator('[contenteditable="true"]');
    const count = await editables.count();
    if (count >= 2) {
        await editables.nth(1).click();
    } else {
        await editables.first().click();
    }

    await page.waitForTimeout(300);
}

/**
 * ツールバーボタンをクリック（テキスト or aria-label で検索）
 * @param {import('playwright').Page} page
 * @param {string} labelOrText
 * @returns {Promise<boolean>}
 */
async function clickToolbarButton(page, labelOrText) {
    const selectors = [
        `[data-testid="toolbar"] button[aria-label*="${labelOrText}"]`,
        `[role="toolbar"] button[aria-label*="${labelOrText}"]`,
        `button[aria-label*="${labelOrText}"]`,
        `button:has-text("${labelOrText}")`
    ];

    for (const selector of selectors) {
        const el = page.locator(selector).first();
        if (await el.isVisible().catch(() => false)) {
            await el.click();
            await page.waitForTimeout(300);
            return true;
        }
    }
    return false;
}

/**
 * 見出しを挿入（ツールバーの見出しドロップダウンから選択）
 * @param {import('playwright').Page} page
 * @param {string} text
 * @param {number} level  2 = 大見出し, 3 = 小見出し
 */
async function insertHeading(page, text, level) {
    console.log(`[Publisher] 見出し H${level}: "${text}"`);

    // ツールバーの "Heading" ボタンを探してクリック
    const headingBtn = page.locator('[aria-label*="Heading"], [aria-label*="見出し"]').first();
    const hasHeadingBtn = await headingBtn.isVisible().catch(() => false);

    if (hasHeadingBtn) {
        await headingBtn.click();
        await page.waitForTimeout(300);

        // ドロップダウンから選択
        const menuText = level === 2 ? ['Heading 1', 'H1', '大見出し'] : ['Heading 2', 'H2', '小見出し'];
        let selected = false;
        for (const text_ of menuText) {
            const item = page.locator(`[role="menuitem"]:has-text("${text_}"), [role="option"]:has-text("${text_}")`).first();
            if (await item.isVisible().catch(() => false)) {
                await item.click();
                selected = true;
                break;
            }
        }

        if (!selected) {
            // ドロップダウンが機能しなかった場合、Escape してキーボードショートカット試行
            await page.keyboard.press('Escape');
        }
    }

    // テキストを入力
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // 通常段落に戻る
    await page.waitForTimeout(200);
}

/**
 * 段落（通常テキスト）を挿入
 * インライン書式（太字・斜体）も処理する
 * @param {import('playwright').Page} page
 * @param {string} text
 */
async function insertParagraph(page, text) {
    // インライン書式を処理しながらタイプ
    const segments = splitInlineFormats(text);

    for (const seg of segments) {
        if (seg.bold) {
            await page.keyboard.down('Control');
            await page.keyboard.press('b');
            await page.keyboard.up('Control');
            await typeWithSpecialChars(page, seg.text);
            await page.keyboard.down('Control');
            await page.keyboard.press('b');
            await page.keyboard.up('Control');
        } else if (seg.italic) {
            await page.keyboard.down('Control');
            await page.keyboard.press('i');
            await page.keyboard.up('Control');
            await typeWithSpecialChars(page, seg.text);
            await page.keyboard.down('Control');
            await page.keyboard.press('i');
            await page.keyboard.up('Control');
        } else {
            await typeWithSpecialChars(page, seg.text);
        }
    }

    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
}

/**
 * テキストを特殊文字に注意しながらタイプ
 * @param {import('playwright').Page} page
 * @param {string} text
 */
async function typeWithSpecialChars(page, text) {
    // 長いテキストはクリップボードを使う
    if (text.length > 100) {
        await page.evaluate((t) => {
            const activeEl = document.activeElement;
            if (activeEl) {
                document.execCommand('insertText', false, t);
            }
        }, text);
    } else {
        await page.keyboard.type(text);
    }
}

/**
 * インライン書式（**bold**, *italic*）をセグメントに分割
 * @param {string} text
 * @returns {Array<{text: string, bold: boolean, italic: boolean}>}
 */
function splitInlineFormats(text) {
    const segments = [];
    // 太字と斜体を検出する正規表現
    const regex = /\*\*(.+?)\*\*|\*([^*]+)\*|`([^`]+)`|(.+?)(?=\*\*|\*|`|$)/gs;

    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
        if (match[1] !== undefined) {
            // **bold**
            segments.push({ text: match[1], bold: true, italic: false });
        } else if (match[2] !== undefined) {
            // *italic*
            segments.push({ text: match[2], bold: false, italic: true });
        } else if (match[3] !== undefined) {
            // `code` → コードとしてではなく通常テキストとして挿入（インラインコードの特別処理は省略）
            segments.push({ text: match[3], bold: false, italic: false });
        } else if (match[4] !== undefined && match[4]) {
            segments.push({ text: match[4], bold: false, italic: false });
        }
        lastIndex = regex.lastIndex;
    }

    // 残りのテキスト
    if (lastIndex < text.length) {
        segments.push({ text: text.slice(lastIndex), bold: false, italic: false });
    }

    // 空のセグメントを除去
    return segments.filter(s => s.text);
}

/**
 * 箇条書きリストを挿入
 * @param {import('playwright').Page} page
 * @param {string[]} items
 */
async function insertBulletList(page, items) {
    console.log(`[Publisher] 箇条書きリスト: ${items.length}件`);

    // ツールバーのリストボタンをクリック
    const listBtnClicked = await clickToolbarButton(page, 'Unordered list') ||
        await clickToolbarButton(page, 'Bullet list') ||
        await clickToolbarButton(page, '箇条書き');

    if (!listBtnClicked) {
        // フォールバック: テキストとして入力
        for (const item of items) {
            await page.keyboard.type(`• ${item}`);
            await page.keyboard.press('Enter');
        }
        return;
    }

    for (let i = 0; i < items.length; i++) {
        const segments = splitInlineFormats(items[i]);
        for (const seg of segments) {
            if (seg.bold) {
                await page.keyboard.down('Control');
                await page.keyboard.press('b');
                await page.keyboard.up('Control');
                await typeWithSpecialChars(page, seg.text);
                await page.keyboard.down('Control');
                await page.keyboard.press('b');
                await page.keyboard.up('Control');
            } else if (seg.italic) {
                await page.keyboard.down('Control');
                await page.keyboard.press('i');
                await page.keyboard.up('Control');
                await typeWithSpecialChars(page, seg.text);
                await page.keyboard.down('Control');
                await page.keyboard.press('i');
                await page.keyboard.up('Control');
            } else {
                await typeWithSpecialChars(page, seg.text);
            }
        }
        if (i < items.length - 1) {
            await page.keyboard.press('Enter');
        }
    }

    // リストを終了して通常段落へ
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
}

/**
 * 番号付きリストを挿入
 * @param {import('playwright').Page} page
 * @param {string[]} items
 */
async function insertNumberedList(page, items) {
    console.log(`[Publisher] 番号付きリスト: ${items.length}件`);

    const listBtnClicked = await clickToolbarButton(page, 'Ordered list') ||
        await clickToolbarButton(page, 'Numbered list') ||
        await clickToolbarButton(page, '番号付き');

    if (!listBtnClicked) {
        for (let idx = 0; idx < items.length; idx++) {
            await page.keyboard.type(`${idx + 1}. ${items[idx]}`);
            await page.keyboard.press('Enter');
        }
        return;
    }

    for (let i = 0; i < items.length; i++) {
        await typeWithSpecialChars(page, items[i]);
        if (i < items.length - 1) {
            await page.keyboard.press('Enter');
        }
    }

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
}

/**
 * 引用ブロックを挿入
 * @param {import('playwright').Page} page
 * @param {string} text
 */
async function insertBlockquote(page, text) {
    console.log(`[Publisher] 引用ブロック`);

    const quoteBtnClicked = await clickToolbarButton(page, 'Quote') ||
        await clickToolbarButton(page, 'Blockquote') ||
        await clickToolbarButton(page, '引用');

    if (!quoteBtnClicked) {
        // フォールバック
        const lines = text.split('\n');
        for (const line of lines) {
            await page.keyboard.type(`> ${line}`);
            await page.keyboard.press('Enter');
        }
        return;
    }

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        await typeWithSpecialChars(page, lines[i]);
        if (i < lines.length - 1) {
            await page.keyboard.down('Shift');
            await page.keyboard.press('Enter');
            await page.keyboard.up('Shift');
        }
    }

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
}

/**
 * コードブロックを挿入
 * @param {import('playwright').Page} page
 * @param {string} code
 */
async function insertCode(page, code) {
    console.log(`[Publisher] コードブロック`);

    // Insert メニューまたはツールバーから "Code" を選択
    const codeBtnClicked = await clickToolbarButton(page, 'Code block') ||
        await clickToolbarButton(page, 'Code') ||
        await clickToolbarButton(page, 'コード');

    if (!codeBtnClicked) {
        // フォールバック: Markdown 記法でそのまま入力
        await page.keyboard.type('```');
        await page.keyboard.press('Enter');
        await page.keyboard.type(code);
        await page.keyboard.press('Enter');
        await page.keyboard.type('```');
        await page.keyboard.press('Enter');
        return;
    }

    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
}

/**
 * 仕切り線（Divider）を挿入
 * @param {import('playwright').Page} page
 */
async function insertDivider(page) {
    console.log(`[Publisher] 仕切り線`);

    await clickToolbarButton(page, 'Divider') ||
        await clickToolbarButton(page, 'Horizontal rule') ||
        await clickToolbarButton(page, '区切り線');

    await page.waitForTimeout(300);
}

/**
 * 画像をアップロード・挿入
 * @param {import('playwright').Page} page
 * @param {string} imagePath  絶対パス
 */
async function insertImage(page, imagePath) {
    console.log(`[Publisher] 画像挿入: ${path.basename(imagePath)}`);

    if (!fs.existsSync(imagePath)) {
        console.warn(`[Publisher] ⚠️  画像ファイルが見つかりません: ${imagePath}`);
        return false;
    }

    try {
        // 改行を入れて新しいブロックへ
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);

        // Image ボタンをクリックしてファイルチューザーを開く
        let chooser = null;

        const imageBtnSelectors = [
            '[aria-label*="Image"]',
            '[aria-label*="Photo"]',
            '[aria-label*="Media"]',
            '[aria-label*="画像"]',
            'button:has-text("Image")',
            'button:has-text("Photo")'
        ];

        for (const selector of imageBtnSelectors) {
            const btn = page.locator(selector).first();
            if (await btn.isVisible().catch(() => false)) {
                try {
                    [chooser] = await Promise.all([
                        page.waitForEvent('filechooser', { timeout: 5000 }),
                        btn.click()
                    ]);
                    break;
                } catch {
                    // 次のセレクターを試す
                }
            }
        }

        if (!chooser) {
            console.warn('[Publisher] ⚠️  画像挿入ボタンが見つかりません');
            return false;
        }

        await chooser.setFiles(imagePath);
        await page.waitForTimeout(4000);

        // アップロード完了を確認（progressbar が消えるのを待つ）
        await page.waitForSelector('[role="progressbar"]', { state: 'hidden', timeout: 30000 }).catch(() => {});

        await page.waitForTimeout(1000);
        console.log(`[Publisher] ✅ 画像挿入完了`);
        return true;
    } catch (error) {
        console.warn(`[Publisher] ❌ 画像挿入失敗: ${error.message}`);
        return false;
    }
}

/**
 * 下書きを保存して記事 URL を取得
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function saveDraft(page) {
    console.log('[Publisher] 下書き保存中...');

    // Save / 保存 ボタンを探す
    const saveBtnSelectors = [
        'button:has-text("Save")',
        'button:has-text("保存")',
        '[data-testid="articleSave"]',
        '[aria-label*="Save"]'
    ];

    for (const selector of saveBtnSelectors) {
        const btn = page.locator(selector).first();
        if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) {
            await btn.click();
            await page.waitForTimeout(3000);
            break;
        }
    }

    // 現在の URL を取得（記事 ID が含まれる）
    const currentUrl = page.url();
    console.log(`[Publisher] 保存完了: ${currentUrl}`);
    return currentUrl;
}

// ========================================
// Main Publisher
// ========================================

/**
 * X Articles に Markdown を投稿
 * @param {Object} params
 * @param {string} params.title
 * @param {string} params.markdown
 * @param {Array<{fileName: string, absolutePath: string}>} params.images
 * @param {boolean} params.headless
 * @returns {Promise<{articleUrl: string}>}
 */
/**
 * ページに Markdown の各要素を入力する（コンテキスト非依存のメインロジック）
 */
async function publishContent(page, title, markdown, images) {
    await createNewArticle(page);
    await setTitle(page, title);
    await focusBody(page);
    await page.waitForTimeout(500);

    const elements = parseMarkdownElements(markdown);
    console.log(`[Publisher] 要素数: ${elements.length}`);

    const imageMap = new Map();
    for (const img of images) {
        if (img.absolutePath && fs.existsSync(img.absolutePath)) {
            imageMap.set(img.fileName, img.absolutePath);
        }
    }

    for (const element of elements) {
        switch (element.type) {
            case 'heading':      await insertHeading(page, element.content, element.level); break;
            case 'paragraph':    await insertParagraph(page, element.content); break;
            case 'bulletList':   await insertBulletList(page, element.items); break;
            case 'numberedList': await insertNumberedList(page, element.items); break;
            case 'quote':        await insertBlockquote(page, element.content); break;
            case 'code':         await insertCode(page, element.content); break;
            case 'divider':      await insertDivider(page); break;
            case 'image': {
                const imgPath = imageMap.get(element.fileName);
                if (imgPath) await insertImage(page, imgPath);
                else console.warn(`[Publisher] ⚠️  画像スキップ: ${element.fileName}`);
                break;
            }
        }
        await page.waitForTimeout(150);
    }

    return await saveDraft(page);
}

async function publishToX({ title, markdown, images = [], headless = true }) {
    console.log('\n[Publisher] X Articles 投稿開始');
    console.log(`[Publisher] タイトル: "${title}"`);
    console.log(`[Publisher] 画像数: ${images.length}`);

    const profileDir = path.join(__dirname, '../.x-chrome-profile');
    const antiBot = () => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['ja', 'en-US', 'en'] });
    };

    // ─── 優先: 専用プロファイルの Chrome（OAuth でログイン済みのセッションを再利用）
    try {
        const ctx = await chromium.launchPersistentContext(profileDir, {
            channel: 'chrome',
            headless,
            slowMo: 80,
            args: ['--disable-blink-features=AutomationControlled'],
            viewport: { width: 1280, height: 900 },
            locale: 'ja-JP',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        });
        await ctx.addInitScript(antiBot);
        console.log('[Publisher] 専用プロファイルの Chrome で投稿');

        const page = await ctx.newPage();
        page.setDefaultTimeout(60000);
        try {
            const articleUrl = await publishContent(page, title, markdown, images);
            return { articleUrl };
        } finally {
            await ctx.close();
        }
    } catch (profileErr) {
        console.warn('[Publisher] 専用プロファイル失敗、Cookie ファイルで再試行:', profileErr.message);
    }

    // ─── フォールバック: x-cookies.json の Cookie で Chromium 起動
    if (!fs.existsSync(COOKIES_PATH)) {
        throw new Error('セッション Cookie が設定されていません。プラグイン設定から「連携する」を実行してください。');
    }

    const storageState = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));

    let browser;
    try {
        browser = await chromium.launch({
            channel: 'chrome',
            headless,
            slowMo: 80,
            args: ['--disable-blink-features=AutomationControlled']
        });
    } catch {
        browser = await chromium.launch({
            headless,
            slowMo: 80,
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
            ignoreDefaultArgs: ['--enable-automation']
        });
    }

    const context = await browser.newContext({
        storageState,
        viewport: { width: 1280, height: 900 },
        locale: 'ja-JP',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });
    await context.addInitScript(antiBot);

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    try {
        const articleUrl = await publishContent(page, title, markdown, images);
        return { articleUrl };
    } finally {
        await browser.close();
    }
}

// ========================================
// CLI Entry Point (debug mode)
// ========================================

if (require.main === module) {
    const args = process.argv.slice(2);
    const debug = args.includes('--debug');

    if (debug) {
        console.log('デバッグモード: テスト投稿を実行します');
        const testMarkdown = `---
title: "テスト記事"
---

# テスト記事

これはテスト用の段落です。**太字テスト**と*斜体テスト*が含まれます。

## 見出し2のテスト

### 見出し3のテスト

- 箇条書き1
- 箇条書き2
- 箇条書き3

1. 番号付き1
2. 番号付き2

> 引用文のテストです。

\`\`\`javascript
const hello = "world";
console.log(hello);
\`\`\`

---

通常の段落に戻ります。
`;

        publishToX({
            title: 'テスト記事',
            markdown: testMarkdown,
            images: [],
            headless: false
        }).then(result => {
            console.log('\n完了:', result.articleUrl);
        }).catch(error => {
            console.error('\nエラー:', error.message);
            process.exit(1);
        });
    } else {
        console.log('使い方: node src/x-publisher.js --debug');
    }
}

module.exports = { publishToX, parseMarkdownElements, extractTitle };
