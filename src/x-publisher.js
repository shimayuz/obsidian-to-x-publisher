#!/usr/bin/env node
/**
 * X Articles Playwright Publisher
 *
 * X (Twitter) Articlesエディタへ Markdown を自動転記
 * - Cookie 保存方式で認証
 * - Markdown → HTML 変換 → DraftJS エディタへ Clipboard paste
 * - 画像は挿入位置ごとに個別アップロード
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
            i++;
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

        // 引用ブロック
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

        // 箇条書きリスト
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

        // 番号付きリスト
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

        // Wikiリンクを通常テキストに変換
        const processedLine = line
            .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (_, linkText) => linkText.trim());

        paragraphBuffer.push(processedLine.trim());
        i++;
    }

    if (paragraphBuffer.length > 0) {
        elements.push({ type: 'paragraph', content: paragraphBuffer.join('\n') });
    }

    return elements;
}

/**
 * Frontmatter からタイトルを抽出
 */
function extractTitle(markdown, fileName) {
    const fmMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
        const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
        if (titleMatch) return titleMatch[1].trim();
    }
    const h1Match = markdown.match(/^#\s+(.+)$/m);
    if (h1Match) return h1Match[1].trim();
    return fileName || '無題';
}

// ========================================
// HTML Conversion (Markdown → HTML for DraftJS paste)
// ========================================

/** HTML 特殊文字をエスケープ */
function escapeHTML(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * インライン Markdown (**bold**, *italic*, `code`) を HTML に変換
 * テキスト内の HTML 特殊文字も適切にエスケープ
 */
function processInlineHTML(text) {
    const parts = [];
    const regex = /\*\*(.+?)\*\*|\*([^*]+)\*|`([^`]+)`/gs;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parts.push(escapeHTML(text.slice(lastIndex, match.index)));
        }
        if (match[1] !== undefined) {
            parts.push(`<strong>${escapeHTML(match[1])}</strong>`);
        } else if (match[2] !== undefined) {
            parts.push(`<em>${escapeHTML(match[2])}</em>`);
        } else if (match[3] !== undefined) {
            parts.push(`<code>${escapeHTML(match[3])}</code>`);
        }
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        parts.push(escapeHTML(text.slice(lastIndex)));
    }

    return parts.join('');
}

/**
 * 解析済み要素配列（画像を除く）を HTML 文字列に変換
 * DraftJS の paste ハンドラが解釈できる形式で出力する
 * - <h2> → 大見出し（header-two）
 * - <h3> → 小見出し（header-three）
 * - <p>  → 本文（unstyled）
 * - <ul>/<ol>/<li> → リスト
 * - <blockquote> → 引用
 * - <pre><code> → コードブロック
 */
function elementsToHTML(elements) {
    const parts = [];
    for (const el of elements) {
        switch (el.type) {
            case 'heading':
                parts.push(`<h${el.level}>${processInlineHTML(el.content)}</h${el.level}>`);
                break;
            case 'paragraph':
                parts.push(`<p>${processInlineHTML(el.content)}</p>`);
                break;
            case 'bulletList':
                parts.push(
                    `<ul>${el.items.map(item => `<li>${processInlineHTML(item)}</li>`).join('')}</ul>`
                );
                break;
            case 'numberedList':
                parts.push(
                    `<ol>${el.items.map(item => `<li>${processInlineHTML(item)}</li>`).join('')}</ol>`
                );
                break;
            case 'quote':
                parts.push(`<blockquote><p>${processInlineHTML(el.content)}</p></blockquote>`);
                break;
            case 'code':
                parts.push(`<pre><code>${escapeHTML(el.content)}</code></pre>`);
                break;
            case 'divider':
                parts.push('<hr>');
                break;
        }
    }
    return parts.join('');
}

// ========================================
// Playwright Editor Operations
// ========================================

/**
 * X Articles の新規記事ページへ移動
 */
async function createNewArticle(page) {
    console.log('[Publisher] X Articles 記事作成ページへ移動...');

    await page.goto('https://x.com/compose/articles', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle').catch(() => {});

    const afterListUrl = page.url();
    console.log(`[Publisher] 現在のURL: ${afterListUrl}`);
    if (afterListUrl.includes('/login') || afterListUrl.includes('/i/flow/login') || afterListUrl.includes('/flow/login')) {
        throw new Error('セッションが期限切れです。Obsidian 設定からログアウト後に再度「連携する」を実行してください。');
    }

    const createBtnSelectors = [
        'button[aria-label="create"]',
        'a:has-text("記事を作成")',
        'a:has-text("Create article")',
        'button:has-text("記事を作成")',
        'button:has-text("Create article")',
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

    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle').catch(() => {});

    const editorUrl = page.url();
    console.log(`[Publisher] エディタURL: ${editorUrl}`);
    if (editorUrl.includes('/login') || editorUrl.includes('/flow/login')) {
        throw new Error('セッションが期限切れです。Obsidian 設定からログアウト後に再度「連携する」を実行してください。');
    }

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
            `スクリーンショット: ${screenshotPath}`
        );
    }

    await page.waitForTimeout(1000);
    console.log('[Publisher] エディタ準備完了');
}

/**
 * 記事タイトルを入力
 */
async function setTitle(page, title) {
    console.log(`[Publisher] タイトル入力: "${title}"`);

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
        await page.keyboard.press('Tab');
        await page.waitForTimeout(300);
    } else {
        const firstEditable = page.locator('[contenteditable="true"]').first();
        await firstEditable.click();
        await page.waitForTimeout(200);
        await page.keyboard.type(title);
    }

    await page.waitForTimeout(500);
}

/**
 * 本文エリアにフォーカスを移動
 */
async function focusBody(page) {
    const bodySelectors = [
        'div.public-DraftEditor-content',
        '[data-testid="article-body"]',
        'div.public-DraftStyleDefault-block',
        '[contenteditable="true"]',
    ];

    for (const selector of bodySelectors) {
        const el = page.locator(selector).first();
        if (await el.isVisible().catch(() => false)) {
            await el.click();
            await page.waitForTimeout(300);
            console.log(`[Publisher] 本文フォーカス: ${selector}`);
            return;
        }
    }

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
 * HTML を DraftJS エディタに貼り付ける
 *
 * DraftJS は paste イベントを監視してHTML→DraftJSブロックに変換する。
 * DataTransfer + ClipboardEvent を dispatch することで
 * ツールバー操作なしに正確なスタイルを適用できる。
 */
async function pasteHTMLToEditor(page, html) {
    if (!html || html.trim() === '') return;

    console.log(`[Publisher] HTML ペースト (${html.length} chars)`);

    await focusBody(page);
    await page.waitForTimeout(300);

    await page.evaluate((htmlContent) => {
        const editorEl = document.querySelector('.public-DraftEditor-content');
        if (!editorEl) throw new Error('DraftJS editor (.public-DraftEditor-content) not found');

        editorEl.focus();

        // DataTransfer に HTML と plain text の両方をセット
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/html', htmlContent);
        dataTransfer.setData('text/plain', htmlContent.replace(/<[^>]*>/g, ''));

        // DraftJS の onPaste ハンドラを起動
        const pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: dataTransfer
        });

        editorEl.dispatchEvent(pasteEvent);
    }, html);

    await page.waitForTimeout(800);
}

// ========================================
// Image Insertion
// ========================================

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
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);

        // ─── Step 1: 「挿入」ボタン → 「メディア」を開く
        let mediaMenuOpened = false;

        for (const quickSel of ['button:has-text("挿入")', 'button[aria-label="Insert"]', 'button[aria-label="挿入"]']) {
            const quickBtn = page.locator(quickSel).first();
            if (await quickBtn.isVisible().catch(() => false)) {
                await quickBtn.click();
                await page.waitForTimeout(400);
                const mediaItem = page.locator('[role="menuitem"]:has-text("メディア"), [role="menuitem"]:has-text("Media")').first();
                if (await mediaItem.isVisible().catch(() => false)) {
                    console.log(`[Publisher] 挿入メニュー発見 (${quickSel})`);
                    await mediaItem.click();
                    mediaMenuOpened = true;
                    await page.waitForTimeout(1500);
                    break;
                }
                await page.keyboard.press('Escape').catch(() => {});
            }
        }

        if (!mediaMenuOpened) {
            // ツールバー全ボタンを走査してフォールバック
            const allToolbarBtns = await page.locator(
                '[data-testid="toolBar"] button, [data-testid="toolbar"] button, [role="toolbar"] button'
            ).all();

            const toolbarLabels = await Promise.all(allToolbarBtns.map(b => b.getAttribute('aria-label').catch(() => '')));
            console.log('[Publisher] ツールバーボタン一覧:', toolbarLabels.filter(Boolean).join(', '));

            for (let i = 0; i < allToolbarBtns.length; i++) {
                const btn = allToolbarBtns[i];
                if (!await btn.isVisible().catch(() => false)) continue;

                try {
                    await btn.click();
                    await page.waitForTimeout(400);

                    const mediaItem = page.locator(
                        '[role="menuitem"]:has-text("メディア"), [role="menuitem"]:has-text("Media")'
                    ).first();

                    if (await mediaItem.isVisible().catch(() => false)) {
                        console.log(`[Publisher] 挿入メニュー発見 (ボタン: "${toolbarLabels[i]}")`);
                        await mediaItem.click();
                        mediaMenuOpened = true;
                        await page.waitForTimeout(1500);
                        break;
                    }

                    await page.keyboard.press('Escape').catch(() => {});
                    await page.waitForTimeout(200);
                } catch {
                    await page.keyboard.press('Escape').catch(() => {});
                }
            }
        }

        if (!mediaMenuOpened) {
            console.warn('[Publisher] ⚠️  挿入メニューを開けませんでした');
            return false;
        }

        // ─── Step 2: input[type="file"] にファイルをセット
        const fileInput = page.locator('input[type="file"]').first();
        const fileInputCount = await fileInput.count();

        if (fileInputCount > 0) {
            console.log('[Publisher] input[type="file"] 検出 → 直接ファイルをセット');
            await fileInput.setInputFiles(imagePath);
        } else {
            const uploadBtnSelectors = [
                'button:has-text("Upload from computer")',
                'button:has-text("コンピューターからアップロード")',
                'button:has-text("ファイルを選択")',
                '[role="dialog"] input[type="file"]',
            ];

            let chooser = null;
            for (const sel of uploadBtnSelectors) {
                const el = page.locator(sel).first();
                if (!await el.isVisible().catch(() => false)) continue;

                const tag = await el.evaluate(n => n.tagName).catch(() => '');
                if (tag === 'INPUT') {
                    await el.setInputFiles(imagePath);
                    chooser = true;
                    break;
                }

                try {
                    [chooser] = await Promise.all([
                        page.waitForEvent('filechooser', { timeout: 5000 }),
                        el.click()
                    ]);
                    break;
                } catch {}
            }

            if (chooser && chooser !== true) {
                await chooser.setFiles(imagePath);
            } else if (!chooser) {
                console.warn('[Publisher] ⚠️  ファイルアップロードUIが見つかりません');
                return false;
            }
        }

        // アップロード完了を待つ
        await page.waitForTimeout(5000);
        await page.waitForSelector('[role="progressbar"]', { state: 'hidden', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // ─── Step 3: カルーセルダイアログ / オーバーレイを閉じる
        // #layers div は X のモーダル・トースト層。ダイアログが残るとポインターイベントをブロックする
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);

        // #layers の子要素が空になるまで待つ
        await page.waitForFunction(() => {
            const layers = document.getElementById('layers');
            if (!layers) return true;
            return layers.children.length === 0;
        }, { timeout: 10000 }).catch(() => {
            console.warn('[Publisher] ⚠️  #layers オーバーレイがタイムアウト内に消えませんでした');
        });
        await page.waitForTimeout(500);

        // エディタ本文に再フォーカス
        await focusBody(page);
        await page.waitForTimeout(300);

        console.log(`[Publisher] ✅ 画像挿入完了`);
        return true;
    } catch (error) {
        console.warn(`[Publisher] ❌ 画像挿入失敗: ${error.message}`);
        return false;
    }
}

// ========================================
// Draft Save
// ========================================

/**
 * 下書きを保存して記事 URL を取得
 */
async function saveDraft(page) {
    console.log('[Publisher] 下書き保存中...');

    await page.waitForTimeout(2000);

    let currentUrl = page.url();
    if (!currentUrl.includes('/edit/')) {
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
 * Markdown → HTML 変換 + 画像位置での個別挿入
 *
 * 処理フロー:
 * 1. Markdown を parseMarkdownElements でブロック配列に変換
 * 2. 画像ブロックを区切りとして連続するテキストブロックを HTML に変換
 * 3. テキストチャンクは pasteHTMLToEditor で DraftJS に一括ペースト
 * 4. 画像は insertImage で個別ファイルアップロード
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

    let textBuffer = [];

    const flushTextBuffer = async () => {
        if (textBuffer.length === 0) return;
        const html = elementsToHTML(textBuffer);
        if (html.trim()) {
            await pasteHTMLToEditor(page, html);
        }
        textBuffer = [];
    };

    for (const element of elements) {
        if (element.type === 'image') {
            // テキストチャンクを先にペースト
            await flushTextBuffer();

            // 画像を挿入位置に個別アップロード
            const imgPath = imageMap.get(element.fileName);
            if (imgPath) {
                await insertImage(page, imgPath);
            } else {
                console.warn(`[Publisher] ⚠️  画像スキップ: ${element.fileName}`);
            }
        } else {
            textBuffer.push(element);
        }

        await page.waitForTimeout(100);
    }

    // 末尾のテキストをペースト
    await flushTextBuffer();

    return await saveDraft(page);
}

/**
 * X Articles に Markdown を投稿
 */
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

    const CDP_PORT = 9223;
    const tempProfileDir = path.join(os.tmpdir(), `x-pub-${Date.now()}`);
    let chromeProc = null;
    let browser = null;
    try {
        const chromeArgs = [
            `--remote-debugging-port=${CDP_PORT}`,
            `--user-data-dir=${tempProfileDir}`,
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

        // x.com のコンテキストにクッキーをインジェクト
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
