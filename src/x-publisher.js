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
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

const COOKIES_PATH = path.join(__dirname, '../x-cookies.json');

// ========================================
// Chrome Binary Helpers (bot-detection bypass)
// ========================================

const CHROME_PATHS_MAC = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function findChromeBinary() {
    for (const p of CHROME_PATHS_MAC) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

async function waitForChromeReady(port, maxMs = 15000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        try {
            const resp = await fetch(`http://localhost:${port}/json/version`);
            if (resp.ok) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}

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
    console.log('[Publisher] X Articles 記事作成ページへ移動...');

    // 正しい URL: https://x.com/compose/articles
    // エディタは https://x.com/compose/articles/edit/{articleId} に移動する
    await page.goto('https://x.com/compose/articles', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle').catch(() => {});

    // ログインリダイレクトを検出
    const afterListUrl = page.url();
    console.log(`[Publisher] 現在のURL: ${afterListUrl}`);
    if (afterListUrl.includes('/login') || afterListUrl.includes('/i/flow/login') || afterListUrl.includes('/flow/login')) {
        throw new Error('セッションが期限切れです。Obsidian 設定からログアウト後に再度「連携する」を実行してください。');
    }

    // 「記事を作成」ボタンをクリックして新規記事を開く
    // URL が compose/articles/edit/{id} に変わるまで待つ
    const createBtnSelectors = [
        'button[aria-label="create"]',
        'button:has-text("記事を作成")',
        'button:has-text("Create article")',
        'button:has-text("New article")',
        '[data-testid="create-article"]'
    ];

    let createBtnClicked = false;
    for (const selector of createBtnSelectors) {
        try {
            const btn = page.locator(selector).first();
            await btn.waitFor({ state: 'visible', timeout: 8000 });
            await btn.click();
            createBtnClicked = true;
            console.log(`[Publisher] 「記事を作成」ボタンクリック: ${selector}`);
            break;
        } catch {
            // 次のセレクターへ
        }
    }

    if (!createBtnClicked) {
        console.warn('[Publisher] 「記事を作成」ボタンが見つかりません。エディタを直接待ちます...');
    }

    // エディタページ（compose/articles/edit/{id}）への移動を待つ
    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle').catch(() => {});

    const editorUrl = page.url();
    console.log(`[Publisher] エディタURL: ${editorUrl}`);
    if (editorUrl.includes('/login') || editorUrl.includes('/flow/login')) {
        throw new Error('セッションが期限切れです。Obsidian 設定からログアウト後に再度「連携する」を実行してください。');
    }

    // エディタ（contenteditable）が現れるまで待つ
    // タイトル欄と本文欄の両方が contenteditable
    const editorSelectors = [
        '[contenteditable="true"]',
        'div.public-DraftEditor-content',
        '[data-testid="article-body"] [contenteditable="true"]'
    ];

    let foundSelector = null;
    for (const sel of editorSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: 15000, state: 'visible' });
            foundSelector = sel;
            console.log(`[Publisher] エディタ検出: ${sel}`);
            break;
        } catch {
            // 次のセレクターへ
        }
    }

    if (!foundSelector) {
        const screenshotPath = `/tmp/x-publisher-debug-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        throw new Error(
            `エディタが表示されませんでした。\n` +
            `URL: ${page.url()}\n` +
            `スクリーンショット: ${screenshotPath}\n` +
            `Cookie が期限切れの可能性があります。ログアウト後に再度「連携する」を実行してください。`
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

    // タイトル欄: placeholder "タイトルを追加" または "Add title" など
    const titleSelectors = [
        '[data-testid="article-title"]',
        '[contenteditable="true"][data-placeholder*="タイトル"]',
        '[contenteditable="true"][data-placeholder*="Title"]',
        'div[contenteditable="true"][aria-label*="タイトル"]',
        'div[contenteditable="true"][aria-label*="Title"]',
        'textarea[placeholder*="タイトル"]',
        'textarea[placeholder*="Title"]'
    ];

    let titleInput = null;
    for (const selector of titleSelectors) {
        const el = page.locator(selector).first();
        if (await el.isVisible().catch(() => false)) {
            titleInput = el;
            console.log(`[Publisher] タイトル欄検出: ${selector}`);
            break;
        }
    }

    if (titleInput) {
        await titleInput.click();
        await page.waitForTimeout(200);
        await titleInput.fill(title);
    } else {
        // フォールバック: 最初の contenteditable をタイトルとして使用
        const firstEditable = page.locator('[contenteditable="true"]').first();
        await firstEditable.click();
        await page.waitForTimeout(200);
        // fill ではなく type を使う（DraftEditor は fill が機能しないことがある）
        await page.keyboard.type(title);
    }

    await page.waitForTimeout(500);
}

/**
 * 本文エリアにフォーカスを移動
 * @param {import('playwright').Page} page
 */
async function focusBody(page) {
    // 本文エリア: タイトル欄の次の contenteditable
    // X Articles では「記事の作成を開始」というプレースホルダーがある
    const bodySelectors = [
        '[data-testid="article-body"]',
        '[contenteditable="true"][data-placeholder*="記事の作成"]',
        '[contenteditable="true"][data-placeholder*="Start writing"]',
        '[contenteditable="true"][data-placeholder*="Body"]',
        '[role="textbox"][aria-label*="Body"]',
        '[role="textbox"][aria-label*="本文"]'
    ];

    for (const selector of bodySelectors) {
        const el = page.locator(selector).first();
        if (await el.isVisible().catch(() => false)) {
            await el.click();
            await page.waitForTimeout(300);
            return;
        }
    }

    // フォールバック: 2番目の contenteditable（タイトルの次が本文）
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
    // X Articles のツールバーはページ上部に固定されている
    const selectors = [
        `[data-testid="toolBar"] button[aria-label*="${labelOrText}"]`,
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

    // X Articles ツールバーの「本文」ドロップダウンから見出しを選択
    // スクリーンショットで確認: ツールバーに「本文」ボタンがあり、クリックするとドロップダウン
    const styleDropdownSelectors = [
        'button:has-text("本文")',
        'button:has-text("Body")',
        '[data-testid="toolBar"] button[aria-label*="Heading"]',
        '[aria-label*="テキストスタイル"]',
        '[aria-label*="text style"]'
    ];

    let dropdownOpened = false;
    for (const selector of styleDropdownSelectors) {
        const el = page.locator(selector).first();
        if (await el.isVisible().catch(() => false)) {
            await el.click();
            await page.waitForTimeout(400);
            dropdownOpened = true;
            break;
        }
    }

    if (dropdownOpened) {
        // level 2 → 大見出し（Heading 1）、level 3 → 小見出し（Heading 2）
        const menuCandidates = level === 2
            ? ['大見出し', 'Heading 1', 'H1', '見出し1']
            : ['小見出し', 'Heading 2', 'H2', '見出し2'];

        let selected = false;
        for (const label of menuCandidates) {
            const item = page.locator(
                `[role="menuitem"]:has-text("${label}"), [role="option"]:has-text("${label}"), li:has-text("${label}")`
            ).first();
            if (await item.isVisible().catch(() => false)) {
                await item.click();
                selected = true;
                await page.waitForTimeout(300);
                break;
            }
        }

        if (!selected) {
            await page.keyboard.press('Escape');
        }
    }

    // テキストを入力して改行
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

    // X Articles は自動保存される（「前回の保存: たった今」と表示）
    // URL が compose/articles/edit/{id} になるのを待つ
    await page.waitForTimeout(2000);

    // URL に記事 ID が含まれているか確認
    let currentUrl = page.url();
    if (!currentUrl.includes('/edit/')) {
        // まだ ID がない場合は少し待つ
        await page.waitForTimeout(3000);
        currentUrl = page.url();
    }

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

    const chromePath = findChromeBinary();
    if (!chromePath) {
        throw new Error('Google Chrome が見つかりません。https://www.google.com/chrome/ からインストールしてください。');
    }

    if (!fs.existsSync(COOKIES_PATH)) {
        throw new Error('セッション Cookie が未設定です。Obsidian 設定の「Chrome でログイン」を実行してください。');
    }

    const storageState = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    const authToken = storageState.cookies?.find(c => c.name === 'auth_token' && c.value)?.value;
    if (!authToken) {
        throw new Error('auth_token が見つかりません。「Chrome でログイン」を再実行してください。');
    }

    // ★ 使い捨て一時プロファイルで Chrome を起動してプロファイルピッカーをスキップ
    //   クッキーはプロファイルに頼らず CDP Network.setCookie で直接注入する
    const CDP_PORT = 9223;
    const tempProfileDir = path.join(os.tmpdir(), `x-pub-${Date.now()}`);
    let chromeProc = null;
    let browser = null;
    try {
        const chromeArgs = [
            `--remote-debugging-port=${CDP_PORT}`,
            `--user-data-dir=${tempProfileDir}`,  // プロファイルピッカーを回避
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-sync',
            '--disable-extensions',
        ];
        if (headless) {
            chromeArgs.push('--headless=new');
        }

        chromeProc = spawn(chromePath, chromeArgs, { stdio: 'ignore', detached: false });
        console.log(`[Publisher] Chrome 起動 (headless=${headless}, CDP port=${CDP_PORT})`);

        const ready = await waitForChromeReady(CDP_PORT, 15000);
        if (!ready) throw new Error('Chrome の起動がタイムアウトしました');

        browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
        const contexts = browser.contexts();
        const context = contexts.length > 0 ? contexts[0] : null;
        if (!context) throw new Error('ブラウザコンテキストが見つかりません');

        const page = await context.newPage();
        page.setDefaultTimeout(60000);

        // x.com のコンテキストにクッキーをインジェクト（ナビゲーション前に設定）
        const cdpSession = await context.newCDPSession(page);
        await cdpSession.send('Network.enable');
        for (const cookie of storageState.cookies) {
            try {
                await cdpSession.send('Network.setCookie', {
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path || '/',
                    expires: cookie.expires || -1,
                    httpOnly: cookie.httpOnly || false,
                    secure: cookie.secure !== false,
                    sameSite: cookie.sameSite || 'None',
                    url: 'https://x.com'
                });
            } catch (e) {
                console.warn(`[Publisher] Cookie ${cookie.name} 設定失敗: ${e.message}`);
            }
        }
        console.log(`[Publisher] ✅ ${storageState.cookies.length} 個のクッキーをインジェクト`);

        const articleUrl = await publishContent(page, title, markdown, images);
        return { articleUrl };
    } finally {
        if (browser) { try { await browser.close(); } catch {} }
        if (chromeProc) { try { chromeProc.kill('SIGTERM'); } catch {} }
        // 一時プロファイルを削除
        try { fs.rmSync(tempProfileDir, { recursive: true, force: true }); } catch {}
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
