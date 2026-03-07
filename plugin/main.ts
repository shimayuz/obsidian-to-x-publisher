import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';
import * as path from 'path';

// ========================================
// Types
// ========================================

interface XPublisherSettings {
    serverUrl: string;
    headlessMode: boolean;
    openAfterPublish: boolean;
    showNotification: boolean;
}

const DEFAULT_SETTINGS: XPublisherSettings = {
    serverUrl: 'http://127.0.0.1:3001',
    headlessMode: true,
    openAfterPublish: true,
    showNotification: true
};

interface ImageInfo {
    fileName: string;
    absolutePath: string;
    exists: boolean;
}

interface ParsedNote {
    title: string;
    body: string;
    images: ImageInfo[];
}

interface PublishResult {
    success: boolean;
    articleUrl?: string;
    error?: string;
}

// ========================================
// Frontmatter Utilities
// ========================================

async function updateFrontmatter(app: App, file: TFile, updates: Record<string, any>): Promise<void> {
    const content = await app.vault.read(file);
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
    const match = content.match(frontmatterRegex);

    let newContent: string;

    if (match) {
        const frontmatterStr = match[1];
        const frontmatterLines = frontmatterStr.split('\n');
        const frontmatterObj: Record<string, any> = {};

        for (const line of frontmatterLines) {
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                const key = line.substring(0, colonIndex).trim();
                let value = line.substring(colonIndex + 1).trim();
                if ((value.startsWith('"') && value.endsWith('"')) ||
                    (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                frontmatterObj[key] = value;
            }
        }

        for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === undefined) {
                delete frontmatterObj[key];
            } else {
                frontmatterObj[key] = value;
            }
        }

        const newFrontmatterLines: string[] = [];
        for (const [key, value] of Object.entries(frontmatterObj)) {
            if (value === '' || value === null || value === undefined) {
                newFrontmatterLines.push(`${key}: ""`);
            } else if (typeof value === 'string' && (value.includes(':') || value.includes('#') || value.includes('"'))) {
                newFrontmatterLines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
            } else {
                newFrontmatterLines.push(`${key}: ${value}`);
            }
        }

        const newFrontmatter = `---\n${newFrontmatterLines.join('\n')}\n---\n`;
        newContent = content.replace(frontmatterRegex, newFrontmatter);
    } else {
        const newFrontmatterLines: string[] = [];
        for (const [key, value] of Object.entries(updates)) {
            if (value !== null && value !== undefined) {
                if (value === '') {
                    newFrontmatterLines.push(`${key}: ""`);
                } else if (typeof value === 'string' && (value.includes(':') || value.includes('#') || value.includes('"'))) {
                    newFrontmatterLines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
                } else {
                    newFrontmatterLines.push(`${key}: ${value}`);
                }
            }
        }
        const newFrontmatter = `---\n${newFrontmatterLines.join('\n')}\n---\n\n`;
        newContent = newFrontmatter + content;
    }

    await app.vault.modify(file, newContent);
}

function getTodayDate(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// ========================================
// X Publisher Client
// ========================================

class XPublisherClient {
    private serverUrl: string;

    constructor(serverUrl: string) {
        this.serverUrl = serverUrl.replace(/\/$/, '');
    }

    setServerUrl(url: string) {
        this.serverUrl = url.replace(/\/$/, '');
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: `${this.serverUrl}/health`,
                method: 'GET'
            });
            return response.status === 200;
        } catch {
            return false;
        }
    }

    async publish(params: {
        title: string;
        markdown: string;
        images?: { fileName: string; absolutePath: string }[];
        headless?: boolean;
    }): Promise<PublishResult> {
        try {
            const bodyStr = JSON.stringify({
                title: params.title,
                markdown: params.markdown,
                images: params.images || [],
                headless: params.headless !== false
            });

            const response = await requestUrl({
                url: `${this.serverUrl}/publish`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: bodyStr,
                throw: false
            });

            if (response.status !== 200) {
                const body = JSON.parse(response.text);
                throw new Error(body.error || `HTTP ${response.status}`);
            }

            const result = JSON.parse(response.text);
            return {
                success: true,
                articleUrl: result.articleUrl
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Unknown error'
            };
        }
    }
}

// ========================================
// Note Parser
// ========================================

async function parseNote(app: App, file: TFile): Promise<ParsedNote> {
    const content = await app.vault.read(file);
    const cache = app.metadataCache.getFileCache(file);

    const title = extractTitle(content, file, cache);
    const body = prepareBody(content);
    const images = await extractImages(app, content, file);

    return { title, body, images };
}

function extractTitle(content: string, file: TFile, cache: any): string {
    const frontmatter = cache?.frontmatter;
    if (frontmatter?.title) return String(frontmatter.title);

    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) return h1Match[1].trim();

    return file.basename;
}

function prepareBody(content: string): string {
    // Frontmatter 除去
    let body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
    return body.trim();
}

async function extractImages(app: App, content: string, file: TFile): Promise<ImageInfo[]> {
    const images: ImageInfo[] = [];
    const fileDir = file.parent?.path || '';
    const vaultPath = (app.vault.adapter as any).basePath || '';

    // Obsidian 形式: ![[image.png]]
    const obsidianRegex = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = obsidianRegex.exec(content)) !== null) {
        const fileName = match[1].trim();
        const info = resolveImageFile(app, fileName, fileDir, vaultPath);
        if (info) images.push(info);
    }

    // 標準 Markdown: ![alt](path)
    const mdRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    while ((match = mdRegex.exec(content)) !== null) {
        const srcPath = match[2].trim();
        if (srcPath.startsWith('http://') || srcPath.startsWith('https://')) continue;
        const info = resolveImageFile(app, srcPath, fileDir, vaultPath);
        if (info) images.push(info);
    }

    return images;
}

function resolveImageFile(app: App, imagePath: string, baseDir: string, vaultPath: string): ImageInfo | null {
    const fileName = path.basename(imagePath);

    // Obsidian のリンク解決
    const linkedFile = app.metadataCache.getFirstLinkpathDest(imagePath, baseDir);
    if (linkedFile && linkedFile instanceof TFile) {
        const absolutePath = vaultPath ? `${vaultPath}/${linkedFile.path}` : linkedFile.path;
        return { fileName, absolutePath, exists: true };
    }

    // Vault 内の直接パス
    const directFile = app.vault.getAbstractFileByPath(imagePath);
    if (directFile && directFile instanceof TFile) {
        const absolutePath = vaultPath ? `${vaultPath}/${directFile.path}` : directFile.path;
        return { fileName, absolutePath, exists: true };
    }

    return { fileName, absolutePath: '', exists: false };
}

// ========================================
// Publish Confirm Modal
// ========================================

class PublishConfirmModal extends Modal {
    private parsedNote: ParsedNote;
    private onConfirm: () => void;
    private onCancel: () => void;

    constructor(app: App, parsedNote: ParsedNote, onConfirm: () => void, onCancel: () => void) {
        super(app);
        this.parsedNote = parsedNote;
        this.onConfirm = onConfirm;
        this.onCancel = onCancel;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'X Article に投稿' });

        new Setting(contentEl)
            .setName('タイトル')
            .setDesc(this.parsedNote.title);

        const images = this.parsedNote.images;
        if (images.length > 0) {
            const found = images.filter(i => i.exists);
            const missing = images.filter(i => !i.exists);
            new Setting(contentEl)
                .setName(`画像 (${images.length}件)`)
                .setDesc(
                    found.map(i => `✓ ${i.fileName}`).join(', ') +
                    (missing.length > 0 ? `  ✗ ${missing.map(i => i.fileName).join(', ')}` : '')
                );
        }

        const preview = this.parsedNote.body.substring(0, 200);
        new Setting(contentEl)
            .setName('本文プレビュー')
            .setDesc(preview + (this.parsedNote.body.length > 200 ? '...' : ''));

        const btnContainer = contentEl.createDiv();
        btnContainer.style.display = 'flex';
        btnContainer.style.gap = '8px';
        btnContainer.style.justifyContent = 'flex-end';
        btnContainer.style.marginTop = '16px';

        const cancelBtn = btnContainer.createEl('button', { text: 'キャンセル' });
        cancelBtn.addEventListener('click', () => {
            this.close();
            this.onCancel();
        });

        const confirmBtn = btnContainer.createEl('button', {
            text: 'X Article に投稿',
            cls: 'mod-cta'
        });
        confirmBtn.addEventListener('click', () => {
            this.close();
            this.onConfirm();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ========================================
// Settings Tab
// ========================================

class XPublisherSettingTab extends PluginSettingTab {
    plugin: XPublisherPlugin;

    constructor(app: App, plugin: XPublisherPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'X Article Publisher 設定' });

        new Setting(containerEl)
            .setName('サーバー URL')
            .setDesc('ローカル HTTP サーバーの URL（デフォルト: http://127.0.0.1:3001）')
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.serverUrl)
                .setValue(this.plugin.settings.serverUrl)
                .onChange(async (value) => {
                    this.plugin.settings = { ...this.plugin.settings, serverUrl: value || DEFAULT_SETTINGS.serverUrl };
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('ヘッドレスモード')
            .setDesc('ブラウザを非表示で実行（推奨: ON）')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.headlessMode)
                .onChange(async (value) => {
                    this.plugin.settings = { ...this.plugin.settings, headlessMode: value };
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('投稿後に X.com を開く')
            .setDesc('下書き保存後にブラウザで X Articles を開く')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.openAfterPublish)
                .onChange(async (value) => {
                    this.plugin.settings = { ...this.plugin.settings, openAfterPublish: value };
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('通知を表示')
            .setDesc('成功・エラー時にポップアップ通知を表示')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showNotification)
                .onChange(async (value) => {
                    this.plugin.settings = { ...this.plugin.settings, showNotification: value };
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('サーバー接続テスト')
            .setDesc('ローカルサーバーとの接続を確認')
            .addButton(button => button
                .setButtonText('テスト')
                .onClick(async () => {
                    button.setButtonText('確認中...');
                    button.setDisabled(true);
                    try {
                        const ok = await this.plugin.xClient.healthCheck();
                        button.setButtonText(ok ? '接続成功!' : '接続失敗');
                    } catch {
                        button.setButtonText('接続失敗');
                    }
                    setTimeout(() => {
                        button.setButtonText('テスト');
                        button.setDisabled(false);
                    }, 2000);
                }));
    }
}

// ========================================
// Main Plugin
// ========================================

export default class XPublisherPlugin extends Plugin {
    settings: XPublisherSettings;
    xClient: XPublisherClient;

    async onload() {
        await this.loadSettings();
        this.xClient = new XPublisherClient(this.settings.serverUrl);

        this.addCommand({
            id: 'publish-to-x-article',
            name: 'X Article に投稿',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (file && file.extension === 'md') {
                    if (!checking) {
                        this.publishCurrentFile(file);
                    }
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'publish-to-x-article-quick',
            name: 'X Article に投稿 (確認なし)',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (file && file.extension === 'md') {
                    if (!checking) {
                        this.publishCurrentFile(file, true);
                    }
                    return true;
                }
                return false;
            }
        });

        this.addRibbonIcon('upload', 'X Article に投稿', async () => {
            const file = this.app.workspace.getActiveFile();
            if (file && file.extension === 'md') {
                await this.publishCurrentFile(file);
            } else {
                new Notice('Markdown ファイルを開いてください');
            }
        });

        this.addSettingTab(new XPublisherSettingTab(this.app, this));
    }

    onunload() {}

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.xClient?.setServerUrl(this.settings.serverUrl);
    }

    async publishCurrentFile(file: TFile, skipConfirmation = false) {
        try {
            const parsedNote = await parseNote(this.app, file);

            if (skipConfirmation) {
                await this.doPublish(parsedNote, file);
            } else {
                new PublishConfirmModal(
                    this.app,
                    parsedNote,
                    () => this.doPublish(parsedNote, file),
                    () => {}
                ).open();
            }
        } catch (error: any) {
            this.handleError(error);
        }
    }

    async doPublish(parsedNote: ParsedNote, file: TFile) {
        const loadingNotice = new Notice('X Article に投稿中...', 0);

        // Frontmatter を publishing 状態に更新
        try {
            await updateFrontmatter(this.app, file, {
                x_status: 'publishing',
                x_error: ''
            });
        } catch (e) {
            // Frontmatter 更新失敗は非致命的
        }

        try {
            const validImages = parsedNote.images
                .filter(img => img.exists)
                .map(img => ({ fileName: img.fileName, absolutePath: img.absolutePath }));

            const result = await this.xClient.publish({
                title: parsedNote.title,
                markdown: parsedNote.body,
                images: validImages,
                headless: this.settings.headlessMode
            });

            loadingNotice.hide();

            if (result.success) {
                const updates: Record<string, any> = {
                    x_status: 'published',
                    x_error: ''
                };

                if (result.articleUrl) {
                    updates.x_url = result.articleUrl;
                }

                const cache = this.app.metadataCache.getFileCache(file);
                if (!cache?.frontmatter?.x_publish_date) {
                    updates.x_publish_date = getTodayDate();
                }

                try {
                    await updateFrontmatter(this.app, file, updates);
                } catch (e) {}

                if (this.settings.showNotification) {
                    new Notice(`投稿完了: "${parsedNote.title}"`);
                }

                if (this.settings.openAfterPublish && result.articleUrl) {
                    window.open(result.articleUrl, '_blank');
                } else if (this.settings.openAfterPublish) {
                    window.open('https://x.com/i/articles', '_blank');
                }
            } else {
                throw new Error(result.error || 'Unknown error');
            }
        } catch (error: any) {
            loadingNotice.hide();

            const errorMessage = this.getShortErrorMessage(error);
            try {
                await updateFrontmatter(this.app, file, {
                    x_status: 'review',
                    x_error: errorMessage
                });
            } catch (e) {}

            this.handleError(error);
        }
    }

    getShortErrorMessage(error: any): string {
        const message = error.message || String(error);

        if (message.includes('ECONNREFUSED') || message.includes('fetch')) {
            return 'サーバー接続失敗';
        }
        if (message.includes('timeout')) return 'タイムアウト';
        if (message.includes('cookies') || message.includes('login')) return '認証エラー';
        if (message.length > 50) return message.substring(0, 47) + '...';
        return message;
    }

    handleError(error: any) {
        const message = error.message || String(error);
        let userMessage = 'X Article への投稿に失敗しました';

        if (message.includes('ECONNREFUSED') || message.includes('fetch')) {
            userMessage = `サーバーに接続できません (${this.settings.serverUrl})。npm run server を実行してください。`;
        } else if (message.includes('cookies') || message.includes('x-cookies')) {
            userMessage = 'Cookie が見つかりません。先に npm run login を実行してください。';
        } else if (message.includes('timeout')) {
            userMessage = 'タイムアウトしました。もう一度お試しください。';
        } else {
            userMessage = `エラー: ${message}`;
        }

        new Notice(userMessage, 10000);
    }
}
