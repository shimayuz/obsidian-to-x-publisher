#!/usr/bin/env node
/**
 * X Articles API Publisher  (Playwright 不要版)
 *
 * X の内部 GraphQL API を直接呼び出して記事を投稿する。
 * DOM 操作ゼロ → 高速・安定・順序保証。
 *
 * capture-api.js で判明した API:
 *   ArticleEntityDraftCreate   POST → 記事作成・ID取得
 *   ArticleEntityUpdateTitle   POST → タイトル更新
 *   ArticleEntityUpdateContent POST → 本文 (DraftJS content_state) 更新
 *   upload.x.com/i/media/upload2.json → 画像アップロード (INIT/APPEND/FINALIZE, allow_async=true)
 *
 * コードブロック → entity_map の type:"MARKDOWN" に ``` ... ``` をそのまま格納
 * 画像          → INIT/APPEND/FINALIZE でアップロード後 type:"MEDIA" entity に格納
 * 区切り線      → type:"DIVIDER" entity
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');

const COOKIES_PATH = path.join(__dirname, '../x-cookies.json');

// X の内部 Bearer トークン（全ユーザー共通の公開トークン）
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// capture-api.js で取得した queryId
const QID = {
    create:        '4hFNtuxZcWaN3xZDBcarkw',
    updateTitle:   'vB7dx2puXvxv071SMcNBwg',
    updateContent: 'S4R4uXKt_Vl1zmpYfBJYvQ',
};

// 全リクエスト共通の features フラグ
const FEATURES = {
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
};

// ========================================
// 認証ヘルパー
// ========================================

function loadAuth() {
    if (!fs.existsSync(COOKIES_PATH)) {
        throw new Error('x-cookies.json が見つかりません。npm run login を実行してください。');
    }
    const state = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    const authToken = state.cookies?.find(c => c.name === 'auth_token')?.value;
    const ct0 = state.cookies?.find(c => c.name === 'ct0')?.value;
    if (!authToken || !ct0) {
        throw new Error('auth_token または ct0 が見つかりません。再ログインしてください。');
    }
    const cookieStr = state.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    return { ct0, cookieStr };
}

function makeHeaders(ct0, cookieStr) {
    return {
        'Authorization': `Bearer ${BEARER}`,
        'Content-Type': 'application/json',
        'x-csrf-token': ct0,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'ja',
        'cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Origin': 'https://x.com',
        'Referer': 'https://x.com/',
        'accept': '*/*',
        'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
    };
}

// ========================================
// GraphQL API
// ========================================

async function graphqlPost(queryId, operationName, variables, headers) {
    const url = `https://x.com/i/api/graphql/${queryId}/${operationName}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ variables, features: FEATURES, queryId }),
    });
    const text = await resp.text();
    if (!resp.ok) {
        throw new Error(`${operationName} failed (${resp.status}): ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
}

/** 新規記事を作成して article entity ID を返す */
async function createArticle(headers) {
    console.log('[API] 記事作成...');
    const resp = await graphqlPost(QID.create, 'ArticleEntityDraftCreate', {
        content_state: { blocks: [], entity_map: [] },
        title: '',
    }, headers);

    console.log('[API] create response:', JSON.stringify(resp).slice(0, 400));

    // レスポンスを再帰的に探索して数値 ID を抽出
    const findId = (obj, depth = 0) => {
        if (!obj || typeof obj !== 'object' || depth > 8) return null;
        if (typeof obj.rest_id === 'string' && /^\d{15,}$/.test(obj.rest_id)) return obj.rest_id;
        if (typeof obj.id === 'string' && /^\d{15,}$/.test(obj.id)) return obj.id;
        for (const v of Object.values(obj)) {
            const found = findId(v, depth + 1);
            if (found) return found;
        }
        return null;
    };

    const articleId = findId(resp);
    if (!articleId) {
        throw new Error(`記事 ID が取得できませんでした。レスポンス: ${JSON.stringify(resp).slice(0, 500)}`);
    }
    console.log(`[API] ✅ 記事 ID: ${articleId}`);
    return articleId;
}

/** タイトルを更新 */
async function updateTitle(articleId, title, headers) {
    console.log(`[API] タイトル更新: "${title}"`);
    return await graphqlPost(QID.updateTitle, 'ArticleEntityUpdateTitle', {
        articleEntityId: articleId,
        title,
    }, headers);
}

/** 本文 content_state を更新 */
async function updateContent(articleId, contentState, headers) {
    console.log(`[API] 本文更新 (${contentState.blocks.length} blocks, ${contentState.entity_map.length} entities)...`);
    const resp = await graphqlPost(QID.updateContent, 'ArticleEntityUpdateContent', {
        content_state: contentState,
        article_entity: articleId,
    }, headers);
    // GraphQL は HTTP 200 でもエラーを返す場合がある
    if (resp.errors?.length) {
        throw new Error(`updateContent GraphQL error: ${JSON.stringify(resp.errors[0])}`);
    }
    return resp;
}

// ========================================
// 画像アップロード (upload.x.com)
// ========================================

const MIME_MAP = {
    '.jpg': ['image/jpeg', 'tweet_image', 'DraftTweetImage'],
    '.jpeg': ['image/jpeg', 'tweet_image', 'DraftTweetImage'],
    '.png': ['image/png', 'tweet_image', 'DraftTweetImage'],
    '.gif': ['image/gif', 'tweet_gif', 'DraftTweetGif'],
    '.webp': ['image/webp', 'tweet_image', 'DraftTweetImage'],
};

// upload2.json を使用（ブラウザと同じ v2 エンドポイント）
const UPLOAD_BASE = 'https://upload.x.com/i/media/upload2.json';

// X Articles 画像 API の上限 (5MB)
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * 5MB 超えの画像を macOS 組み込みの sips で JPEG 圧縮する。
 * 圧縮不要なら元ファイルをそのまま返す。圧縮できなければ throw。
 * @returns {{ filePath: string, isTemp: boolean }}
 */
function compressImageIfNeeded(imagePath) {
    const originalSize = fs.statSync(imagePath).size;
    if (originalSize <= MAX_UPLOAD_BYTES) return { filePath: imagePath, isTemp: false };

    const basename = path.basename(imagePath, path.extname(imagePath));
    const tmpPath = path.join(os.tmpdir(), `${basename}_xpub_compressed.jpg`);

    console.log(`[API]   ⚠️  ${(originalSize / 1024 / 1024).toFixed(1)}MB > 5MB 制限 → sips で圧縮します`);

    // 品質を段階的に下げながら 5MB 未満になるまで試す
    for (const quality of [80, 60, 40, 20]) {
        try {
            execSync(
                `sips -s format jpeg -s formatOptions ${quality} -Z 2048 "${imagePath}" --out "${tmpPath}"`,
                { stdio: 'ignore' }
            );
            const compressedSize = fs.statSync(tmpPath).size;
            if (compressedSize <= MAX_UPLOAD_BYTES) {
                console.log(`[API]   ✅ 圧縮完了: ${(originalSize / 1024).toFixed(0)}KB → ${(compressedSize / 1024).toFixed(0)}KB (JPEG ${quality}%)`);
                return { filePath: tmpPath, isTemp: true };
            }
        } catch (_) {
            // sips が使用できない場合はここで抜ける
            break;
        }
    }

    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    throw new Error(`maxFileSizeExceeded: ${(originalSize / 1024 / 1024).toFixed(1)}MB の画像を 5MB 以下に圧縮できませんでした`);
}

/** 画像をアップロードして { mediaId, mediaCategory } を返す */
async function uploadImage(imagePath, ct0, cookieStr) {
    // 5MB 超えの場合は sips で圧縮（macOS 組み込みツール）
    const { filePath, isTemp } = compressImageIfNeeded(imagePath);

    try {
        return await _uploadImageFile(filePath, imagePath, ct0, cookieStr);
    } finally {
        if (isTemp && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
}

async function _uploadImageFile(filePath, originalPath, ct0, cookieStr) {
    const fileBuffer = fs.readFileSync(filePath);
    const totalBytes = fileBuffer.length;

    const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
    // 圧縮後は JPEG になっているので拡張子は圧縮後のファイルから取得
    const ext = path.extname(filePath).toLowerCase();
    const [mediaType, mediaCategory, draftCategory] = MIME_MAP[ext] || ['image/jpeg', 'tweet_image', 'DraftTweetImage'];

    const uploadHeaders = makeHeaders(ct0, cookieStr);
    delete uploadHeaders['Content-Type']; // multipart は自動設定

    console.log(`[API] 画像アップロード: ${path.basename(originalPath)} (${(totalBytes / 1024).toFixed(0)}KB)`);

    // INIT
    const initResp = await fetch(
        `${UPLOAD_BASE}?command=INIT&total_bytes=${totalBytes}&media_type=${encodeURIComponent(mediaType)}&media_category=${mediaCategory}`,
        { method: 'POST', headers: { ...uploadHeaders, 'Content-Type': 'application/json' } }
    );
    if (!initResp.ok) throw new Error(`Upload INIT failed: ${await initResp.text()}`);
    const initData = await initResp.json();
    const mediaId = initData.media_id_string;
    console.log(`[API]   media_id: ${mediaId}`);

    // APPEND
    const formData = new FormData();
    formData.append('media', new Blob([fileBuffer], { type: mediaType }), path.basename(filePath));
    const appendResp = await fetch(
        `${UPLOAD_BASE}?command=APPEND&media_id=${mediaId}&segment_index=0`,
        { method: 'POST', headers: uploadHeaders, body: formData }
    );
    if (!appendResp.ok) throw new Error(`Upload APPEND failed: ${await appendResp.text()}`);

    // FINALIZE（allow_async=true でブラウザと同じ非同期処理モード）
    const finalizeResp = await fetch(
        `${UPLOAD_BASE}?command=FINALIZE&media_id=${mediaId}&original_md5=${md5}&allow_async=true`,
        { method: 'POST', headers: { ...uploadHeaders, 'Content-Type': 'application/json' } }
    );
    if (!finalizeResp.ok) throw new Error(`Upload FINALIZE failed: ${await finalizeResp.text()}`);
    const finalizeData = await finalizeResp.json().catch(() => ({}));

    // FINALIZE 後に STATUS で完了を確認（PNG 等の非同期処理に対応）
    await waitForMediaReady(mediaId, uploadHeaders, finalizeData);

    console.log(`[API]   ✅ アップロード完了: ${mediaId}`);
    return { mediaId, draftCategory };
}

/** FINALIZE 後に STATUS ポーリングでメディアが使用可能になるまで待つ */
async function waitForMediaReady(mediaId, headers, finalizeData) {
    // FINALIZE レスポンスに processing_info がなければ同期完了 → STATUS 不要
    const initialState = finalizeData.processing_info?.state;
    if (!initialState || initialState === 'succeeded') return;

    // 非同期処理中: STATUS でポーリング
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
        const waitSecs = finalizeData.processing_info?.check_after_secs || 1;
        await new Promise(r => setTimeout(r, waitSecs * 1000));

        const resp = await fetch(
            `${UPLOAD_BASE}?command=STATUS&media_id=${mediaId}`,
            { method: 'GET', headers }
        );
        if (!resp.ok) return; // STATUS エンドポイントが応答しない場合は完了とみなす

        const data = await resp.json().catch(() => ({}));
        const state = data.processing_info?.state;
        console.log(`[API]   processing: ${state}`);

        if (!state || state === 'succeeded') return;
        if (state === 'failed') throw new Error(`Upload processing failed: ${JSON.stringify(data)}`);

        // 次回チェックまでの待機時間を更新
        finalizeData.processing_info = data.processing_info;
    }
    throw new Error(`Upload processing timeout for media_id: ${mediaId}`);
}

// ========================================
// Markdown パーサー
// ========================================

function parseMarkdownElements(markdown) {
    let content = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
    content = content.replace(/^#\s+.+\n?/, '');

    const elements = [];
    const lines = content.split('\n');
    let buf = [];
    let i = 0;

    const flushBuf = () => {
        if (buf.length) {
            elements.push({ type: 'paragraph', content: buf.join('\n') });
            buf = [];
        }
    };

    while (i < lines.length) {
        const line = lines[i];

        if (line.trim() === '') { flushBuf(); i++; continue; }

        if (line.startsWith('```')) {
            flushBuf();
            const language = line.slice(3).trim();
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++; }
            elements.push({ type: 'code', content: codeLines.join('\n'), language });
            i++; continue;
        }

        if (line.startsWith('## ') && !line.startsWith('### ')) {
            flushBuf();
            elements.push({ type: 'heading', content: line.slice(3).trim(), level: 2 });
            i++; continue;
        }

        if (line.startsWith('### ')) {
            flushBuf();
            elements.push({ type: 'heading', content: line.slice(4).trim(), level: 3 });
            i++; continue;
        }

        if (line.match(/^---+$/) || line.match(/^\*\*\*+$/)) {
            flushBuf();
            elements.push({ type: 'divider' });
            i++; continue;
        }

        if (line.startsWith('>')) {
            flushBuf();
            const ql = [];
            while (i < lines.length && lines[i].startsWith('>')) { ql.push(lines[i].replace(/^>[ ]?/, '')); i++; }
            elements.push({ type: 'quote', content: ql.join('\n') });
            continue;
        }

        if (line.match(/^[-*] /)) {
            flushBuf();
            const items = [];
            while (i < lines.length && lines[i].match(/^[-*] /)) { items.push(lines[i].replace(/^[-*] /, '').trim()); i++; }
            elements.push({ type: 'bulletList', items }); continue;
        }

        if (line.match(/^\d+\. /)) {
            flushBuf();
            const items = [];
            while (i < lines.length && lines[i].match(/^\d+\. /)) { items.push(lines[i].replace(/^\d+\. /, '').trim()); i++; }
            elements.push({ type: 'numberedList', items }); continue;
        }

        const obsImg = line.match(/^!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
        if (obsImg) {
            flushBuf();
            elements.push({ type: 'image', fileName: obsImg[1].trim() });
            i++; continue;
        }

        const mdImg = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (mdImg && !mdImg[2].startsWith('http')) {
            flushBuf();
            elements.push({ type: 'image', fileName: path.basename(mdImg[2]) });
            i++; continue;
        }

        buf.push(line.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (_, t) => t.trim()).trim());
        i++;
    }
    flushBuf();
    return elements;
}

function extractTitle(markdown, fileName) {
    const fm = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fm) {
        const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
        if (tm) return tm[1].trim();
    }
    const h1 = markdown.match(/^#\s+(.+)$/m);
    if (h1) return h1[1].trim();
    return fileName || '無題';
}

// ========================================
// インライン書式 → DraftJS inline_style_ranges
// ========================================

/**
 * **bold**, *italic*, `code` を DraftJS の inline_style_ranges に変換
 * @returns {{ text: string, inline_style_ranges: Array }}
 */
function parseInline(markdown) {
    const styleRanges = [];
    let text = '';
    // X Articles API のスタイル名は Pascal Case（capture-api で確認済み）
    // "Bold", "Italic", "Strikethrough" のみサポート（"CODE" は非サポート）
    const regex = /\*\*(.+?)\*\*|\*([^*]+)\*|~~(.+?)~~|`([^`]+)`/gs;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(markdown)) !== null) {
        text += markdown.slice(lastIndex, match.index);
        if (match[1] !== undefined) {
            styleRanges.push({ offset: text.length, length: match[1].length, style: 'Bold' });
            text += match[1];
        } else if (match[2] !== undefined) {
            styleRanges.push({ offset: text.length, length: match[2].length, style: 'Italic' });
            text += match[2];
        } else if (match[3] !== undefined) {
            styleRanges.push({ offset: text.length, length: match[3].length, style: 'Strikethrough' });
            text += match[3];
        } else if (match[4] !== undefined) {
            // `code` → プレーンテキスト（インライン CODE は X API 非サポート）
            text += match[4];
        }
        lastIndex = match.index + match[0].length;
    }
    text += markdown.slice(lastIndex);
    return { text, inline_style_ranges: styleRanges };
}

// ========================================
// Markdown elements → DraftJS content_state
// ========================================

function randomKey() {
    return Math.random().toString(36).slice(2, 7);
}

/**
 * 解析済み要素 + MEDIA entity 配列 → DraftJS content_state
 *
 * entity_map 構造 (capture-api.js で判明):
 *   [ { key: "0", value: { data: {...}, type: "MEDIA"|"MARKDOWN"|"DIVIDER", mutability: "..." } } ]
 *
 * blocks 内 entity_ranges:
 *   [ { key: 0, offset: 0, length: 1 } ]  ← key は数値（entity_map のインデックス）
 */
function buildContentState(elements, mediaEntityMap) {
    const blocks = [];
    const entity_map = [...mediaEntityMap];
    let nextKey = entity_map.length;

    for (const el of elements) {
        switch (el.type) {
            case 'paragraph': {
                const { text, inline_style_ranges } = parseInline(el.content);
                blocks.push({ data: {}, text, key: randomKey(), type: 'unstyled', entity_ranges: [], inline_style_ranges });
                break;
            }
            case 'heading': {
                // ## → header-one (大見出し), ### → header-two (小見出し)
                const type = el.level === 2 ? 'header-one' : 'header-two';
                const { text, inline_style_ranges } = parseInline(el.content);
                blocks.push({ data: {}, text, key: randomKey(), type, entity_ranges: [], inline_style_ranges });
                break;
            }
            case 'bulletList': {
                for (const item of el.items) {
                    const { text, inline_style_ranges } = parseInline(item);
                    blocks.push({ data: {}, text, key: randomKey(), type: 'unordered-list-item', entity_ranges: [], inline_style_ranges });
                }
                break;
            }
            case 'numberedList': {
                for (const item of el.items) {
                    const { text, inline_style_ranges } = parseInline(item);
                    blocks.push({ data: {}, text, key: randomKey(), type: 'ordered-list-item', entity_ranges: [], inline_style_ranges });
                }
                break;
            }
            case 'quote': {
                for (const line of el.content.split('\n')) {
                    const { text, inline_style_ranges } = parseInline(line);
                    blocks.push({ data: {}, text, key: randomKey(), type: 'blockquote', entity_ranges: [], inline_style_ranges });
                }
                break;
            }
            case 'code': {
                // コードブロック: type:"MARKDOWN" entity に ``` lang\n...\n``` を格納
                const ek = nextKey++;
                const lang = el.language || '';
                entity_map.push({
                    key: String(ek),
                    value: {
                        data: { markdown: `\`\`\`${lang}\n${el.content}\n\`\`\`` },
                        type: 'MARKDOWN',
                        mutability: 'Mutable',
                    },
                });
                blocks.push({
                    data: {}, text: ' ', key: randomKey(), type: 'atomic',
                    entity_ranges: [{ key: ek, offset: 0, length: 1 }],
                    inline_style_ranges: [],
                });
                break;
            }
            case 'divider': {
                // 区切り線: type:"DIVIDER" entity
                const ek = nextKey++;
                entity_map.push({
                    key: String(ek),
                    value: { data: {}, type: 'DIVIDER', mutability: 'Immutable' },
                });
                blocks.push({
                    data: {}, text: ' ', key: randomKey(), type: 'atomic',
                    entity_ranges: [{ key: ek, offset: 0, length: 1 }],
                    inline_style_ranges: [],
                });
                break;
            }
            case 'image': {
                // el.mediaEntityIdx が事前設定済みの場合のみ挿入
                if (el.mediaEntityIdx !== undefined) {
                    blocks.push({
                        data: {}, text: ' ', key: randomKey(), type: 'atomic',
                        entity_ranges: [{ key: el.mediaEntityIdx, offset: 0, length: 1 }],
                        inline_style_ranges: [],
                    });
                }
                break;
            }
        }
    }

    // 末尾に空ブロック（エディタの慣習）
    blocks.push({ data: {}, text: '', key: randomKey(), type: 'unstyled', entity_ranges: [], inline_style_ranges: [] });

    return { blocks, entity_map };
}

// ========================================
// メイン Publisher
// ========================================

async function publishToXAPI({ title, markdown, images = [] }) {
    console.log('\n[API Publisher] X Articles 投稿開始');
    console.log(`[API Publisher] タイトル: "${title}"`);
    console.log(`[API Publisher] 画像数: ${images.length}`);

    const { ct0, cookieStr } = loadAuth();
    const headers = makeHeaders(ct0, cookieStr);

    // 1. 記事を作成して ID 取得
    const articleId = await createArticle(headers);

    // 2. タイトルを更新
    await updateTitle(articleId, title, headers);

    // 3. Markdown を解析
    const elements = parseMarkdownElements(markdown);
    console.log(`[API Publisher] 要素数: ${elements.length}`);

    // 4. 画像をアップロードして MEDIA entity を構築
    const imageMap = new Map(); // fileName → { mediaId, draftCategory }
    for (const img of images) {
        if (!img.absolutePath || !fs.existsSync(img.absolutePath)) {
            console.warn(`[API Publisher] ⚠️  画像ファイル不在: ${img.fileName}`);
            continue;
        }
        try {
            const result = await uploadImage(img.absolutePath, ct0, cookieStr);
            imageMap.set(img.fileName, result);
        } catch (e) {
            console.warn(`[API Publisher] ⚠️  画像アップロード失敗: ${img.fileName} - ${e.message}`);
        }
    }

    // MEDIA entity を entity_map の先頭に配置（画像が出現する順番で）
    const mediaEntityMap = [];
    let localMediaId = 1;
    for (const el of elements) {
        if (el.type !== 'image') continue;
        const result = imageMap.get(el.fileName);
        if (result) {
            el.mediaEntityIdx = mediaEntityMap.length;
            mediaEntityMap.push({
                key: String(mediaEntityMap.length),
                value: {
                    data: {
                        entity_key: crypto.randomUUID(),
                        media_items: [{
                            local_media_id: localMediaId++,
                            media_category: result.draftCategory,
                            media_id: result.mediaId,
                        }],
                    },
                    type: 'MEDIA',
                    mutability: 'Immutable',
                },
            });
        } else {
            console.warn(`[API Publisher] ⚠️  画像スキップ: ${el.fileName}`);
        }
    }

    // 5. content_state を構築して更新（メディアエラー時はバイナリサーチで上限を探す）
    const contentState = buildContentState(elements, mediaEntityMap);

    try {
        await updateContent(articleId, contentState, headers);
    } catch (mediaErr) {
        if (!mediaErr.message.includes('Invalid article media')) throw mediaErr;

        console.warn(`[API Publisher] ⚠️  メディアエラー (${mediaEntityMap.length}枚)。上限を二分探索します...`);

        const maxMediaCount = await findMaxMediaCount(articleId, elements, mediaEntityMap, headers);

        if (maxMediaCount === 0) {
            console.warn('[API Publisher] ⚠️  メディアが全て使用不可。画像なしで送信します...');
            const noMediaElements = elements.map(el =>
                el.type === 'image' ? { type: 'paragraph', content: `[画像: ${el.fileName}]` } : el
            );
            await updateContent(articleId, buildContentState(noMediaElements, []), headers);
            console.warn('[API Publisher] ⚠️  画像なし投稿完了（画像は手動で追加してください）');
        } else {
            console.log(`[API Publisher] ✅ ${maxMediaCount}枚で送信完了（上限 ${maxMediaCount}枚）`);
        }
    }

    const articleUrl = `https://x.com/compose/articles/edit/${articleId}`;
    console.log(`\n[API Publisher] ✅ 投稿完了: ${articleUrl}`);
    return { articleUrl };
}

/**
 * "Invalid article media" 時に、受け入れ可能なメディア最大数を二分探索する。
 * 成功した場合はその枚数で updateContent 済み。失敗(0)の場合は何もしない。
 */
async function findMaxMediaCount(articleId, elements, mediaEntityMap, headers) {
    let lo = 0;
    let hi = mediaEntityMap.length - 1;
    let lastSuccess = 0;

    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const trialCount = mid + 1; // 1-indexed
        const trialMap = mediaEntityMap.slice(0, trialCount);

        // 対応する elements を再マップ（後半の画像はプレースホルダーに）
        let imgIdx = 0;
        const trialElements = elements.map(el => {
            if (el.type !== 'image') return el;
            const useMedia = imgIdx < trialCount && el.mediaEntityIdx !== undefined;
            imgIdx++;
            return useMedia ? el : { type: 'paragraph', content: `[画像: ${el.fileName}]` };
        });

        console.log(`[API Publisher]   試行: ${trialCount}枚...`);
        try {
            await updateContent(articleId, buildContentState(trialElements, trialMap), headers);
            lastSuccess = trialCount;
            lo = mid + 1;
            console.log(`[API Publisher]   ✅ ${trialCount}枚 OK`);
        } catch (e) {
            if (!e.message.includes('Invalid article media')) throw e;
            hi = mid - 1;
            console.log(`[API Publisher]   ❌ ${trialCount}枚 NG`);
        }
    }

    if (lastSuccess > 0) {
        console.warn(`[API Publisher] ⚠️  X Articles の画像上限: ${lastSuccess}枚`);
    }
    return lastSuccess;
}

// ========================================
// CLI Entry Point
// ========================================

if (require.main === module) {
    const testMarkdown = `---
title: "APIテスト記事"
---

# APIテスト記事

これはAPIパブリッシャーのテストです。**太字**と*斜体*と\`インラインコード\`が使えます。

## 大見出しのテスト

### 小見出しのテスト

- 箇条書き1
- 箇条書き2（**太字**を含む）

1. 番号付き1
2. 番号付き2

> これは引用文です。
> 複数行も対応しています。

\`\`\`javascript
// コードブロックのテスト
const hello = 'world';
console.log(hello);
\`\`\`

---

通常の段落に戻ります。APIで直接送信！
`;

    publishToXAPI({
        title: 'APIテスト記事',
        markdown: testMarkdown,
        images: [],
    }).then(r => {
        console.log('完了:', r.articleUrl);
    }).catch(e => {
        console.error('エラー:', e.message);
        process.exit(1);
    });
}

module.exports = { publishToXAPI, parseMarkdownElements, extractTitle };
