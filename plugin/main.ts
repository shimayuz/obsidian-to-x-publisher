import { App, ButtonComponent, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';
import * as path from 'path';

// ========================================
// Types
// ========================================

interface XPublisherSettings {
    serverUrl: string;
    clientId: string;
    clientSecret: string;
    headlessMode: boolean;
    openAfterPublish: boolean;
    showNotification: boolean;
}

const DEFAULT_SETTINGS: XPublisherSettings = {
    serverUrl: 'http://127.0.0.1:3001',
    clientId: '',
    clientSecret: '',
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

interface OAuthStatus {
    status: 'idle' | 'pending' | 'success' | 'error';
    error: string | null;
    authenticated: boolean;   // backward compat: sessionReady
    oauthConnected?: boolean; // Bearer token obtained
    sessionReady?: boolean;   // Playwright cookies set
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

    async startOAuth(clientId: string, clientSecret?: string): Promise<void> {
        const body: Record<string, string> = { clientId };
        if (clientSecret) body.clientSecret = clientSecret;

        const response = await requestUrl({
            url: `${this.serverUrl}/oauth/start`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            throw: false
        });

        // 409 = already pending → OK to just poll
        if (response.status === 409) return;

        if (response.status !== 200) {
            const parsed = JSON.parse(response.text);
            throw new Error(parsed.error || `HTTP ${response.status}`);
        }
    }

    async getOAuthStatus(): Promise<OAuthStatus> {
        try {
            const response = await requestUrl({
                url: `${this.serverUrl}/oauth/status`,
                method: 'GET',
                throw: false
            });

            if (response.status !== 200) {
                return { status: 'error', error: 'サーバーを再起動してください（npm run server）', authenticated: false };
            }

            // Guard against non-JSON responses (e.g. old server returning HTML)
            const text = response.text?.trim() ?? '';
            if (!text.startsWith('{')) {
                return { status: 'error', error: 'サーバーを再起動してください（npm run server）', authenticated: false };
            }

            return JSON.parse(text) as OAuthStatus;
        } catch {
            return { status: 'error', error: 'サーバーが起動していません（npm run server）', authenticated: false };
        }
    }

    async saveSessionCookies(authToken: string, csrfToken?: string): Promise<void> {
        const body: Record<string, string> = { authToken };
        if (csrfToken) body.csrfToken = csrfToken;

        const response = await requestUrl({
            url: `${this.serverUrl}/session/cookies`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            throw: false
        });

        if (response.status !== 200) {
            const parsed = JSON.parse(response.text);
            throw new Error(parsed.error || `HTTP ${response.status}`);
        }
    }

    async logout(): Promise<void> {
        const response = await requestUrl({
            url: `${this.serverUrl}/session/logout`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
            throw: false
        });

        if (response.status !== 200) {
            const parsed = JSON.parse(response.text);
            throw new Error(parsed.error || `HTTP ${response.status}`);
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
            return { success: true, articleUrl: result.articleUrl };
        } catch (error: any) {
            return { success: false, error: error.message || 'Unknown error' };
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
    return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
}

async function extractImages(app: App, content: string, file: TFile): Promise<ImageInfo[]> {
    const images: ImageInfo[] = [];
    const fileDir = file.parent?.path || '';
    const vaultPath = (app.vault.adapter as any).basePath || '';

    // Obsidian 形式: ![[image.png]]
    const obsidianRegex = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = obsidianRegex.exec(content)) !== null) {
        const info = resolveImageFile(app, match[1].trim(), fileDir, vaultPath);
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

    const linkedFile = app.metadataCache.getFirstLinkpathDest(imagePath, baseDir);
    if (linkedFile && linkedFile instanceof TFile) {
        const absolutePath = vaultPath ? `${vaultPath}/${linkedFile.path}` : linkedFile.path;
        return { fileName, absolutePath, exists: true };
    }

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
        btnContainer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;';

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
    private pollingActive = false;

    constructor(app: App, plugin: XPublisherPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        this.pollingActive = false; // Cancel any running polling

        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'X Article Publisher 設定' });

        // ─── X Developer App ───
        containerEl.createEl('h3', { text: 'X Developer App' });

        const descEl = containerEl.createEl('p', { cls: 'setting-item-description' });
        descEl.style.cssText = 'margin: 0 0 12px; font-size: 13px; color: var(--text-muted);';
        descEl.innerHTML =
            '<a href="https://developer.x.com" target="_blank">developer.x.com</a> でアプリを作成し、' +
            'OAuth 2.0 を有効化。Callback URI に ' +
            '<code>http://127.0.0.1:3001/oauth/callback</code> を登録してください。';

        new Setting(containerEl)
            .setName('Client ID')
            .setDesc('X Developer Portal → Keys and tokens → Client ID')
            .addText(text => text
                .setPlaceholder('例: xxxxxxxxxxxxxxxxxxxx')
                .setValue(this.plugin.settings.clientId)
                .onChange(async (value) => {
                    this.plugin.settings = { ...this.plugin.settings, clientId: value };
                    await this.plugin.saveSettings();
                }));

        let secretInputEl: HTMLInputElement;
        new Setting(containerEl)
            .setName('Client Secret')
            .setDesc('Confidential Client の場合のみ入力（Public Client は空欄で OK）')
            .addText(text => {
                text.inputEl.type = 'password';
                secretInputEl = text.inputEl;
                text.setPlaceholder('Client Secret（任意）')
                    .setValue(this.plugin.settings.clientSecret)
                    .onChange(async (value) => {
                        this.plugin.settings = { ...this.plugin.settings, clientSecret: value };
                        await this.plugin.saveSettings();
                    });
            })
            .addExtraButton(button => {
                button
                    .setIcon('eye')
                    .setTooltip('表示/非表示')
                    .onClick(() => {
                        const hidden = secretInputEl.type === 'password';
                        secretInputEl.type = hidden ? 'text' : 'password';
                        button.setIcon(hidden ? 'eye-off' : 'eye');
                    });
            });

        // ─── X アカウント連携 ───
        containerEl.createEl('h3', { text: 'X アカウント連携' });

        const statusEl = containerEl.createDiv();
        statusEl.style.cssText = 'padding: 4px 0 12px; font-size: 13px;';
        statusEl.setText('● 接続状態を確認中...');

        let connectBtn!: ButtonComponent;
        let sessionStatusEl!: HTMLElement; // logout ボタンから参照するため早期宣言

        new Setting(containerEl)
            .setName('X アカウントを連携')
            .setDesc('クリックするとブラウザが起動し、X のログイン画面が表示されます')
            .addButton(button => {
                connectBtn = button;
                button
                    .setButtonText('連携する')
                    .setCta()
                    .onClick(() => this.startOAuthFlow(connectBtn, statusEl));
            });

        new Setting(containerEl)
            .setName('ログアウト / 連携解除')
            .setDesc('X との連携を解除し、保存された Cookie・Chrome プロファイルをすべて削除します')
            .addButton(button => {
                button
                    .setButtonText('ログアウト')
                    .setWarning()
                    .onClick(async () => {
                        const isServerUp = await this.plugin.xClient.healthCheck();
                        if (!isServerUp) {
                            new Notice('サーバーが起動していません。npm run server を実行してください。', 6000);
                            return;
                        }
                        button.setButtonText('ログアウト中...').setDisabled(true);
                        try {
                            await this.plugin.xClient.logout();
                            statusEl.setText('● 未接続');
                            statusEl.style.color = 'var(--text-muted)';
                            if (sessionStatusEl) {
                                sessionStatusEl.setText('● 未設定（auth_token を入力してください）');
                                sessionStatusEl.style.color = 'var(--text-muted)';
                            }
                            connectBtn.setButtonText('連携する').setDisabled(false);
                            new Notice('ログアウトしました。再度「連携する」から認証してください。', 6000);
                        } catch (err: any) {
                            new Notice(`ログアウト失敗: ${err.message}`);
                        } finally {
                            button.setButtonText('ログアウト').setDisabled(false);
                        }
                    });
            });

        // ─── セッション Cookie 設定 ───
        containerEl.createEl('h3', { text: 'セッション Cookie 設定' });

        const cookieDescEl = containerEl.createEl('p', { cls: 'setting-item-description' });
        cookieDescEl.style.cssText = 'margin: 0 0 12px; font-size: 13px; color: var(--text-muted);';
        cookieDescEl.innerHTML =
            '⚠️ <b>OAuth 認証後に設定が必要です（一度だけ）</b><br><br>' +
            '<b>手順：</b> <a href="https://x.com" target="_blank">x.com</a> にログインしているブラウザで<br>' +
            '開発者ツール（Mac: <code>Cmd+Option+I</code> / Win: <code>F12</code>）を開き、<br>' +
            '<b>Application</b> タブ → <b>Cookies</b> → <b>https://x.com</b> を選択し、<br>' +
            '<code>auth_token</code> と <code>ct0</code> の Value をコピーして貼り付けてください。<br>' +
            '<small>※ auth_token は httpOnly なので JavaScript では取得できません（DevTools 必須）</small>';

        let authTokenInputEl: HTMLInputElement;
        new Setting(containerEl)
            .setName('auth_token')
            .setDesc('X のセッション認証トークン（必須）')
            .addText(text => {
                text.inputEl.type = 'password';
                authTokenInputEl = text.inputEl;
                text.setPlaceholder('auth_token の値を貼り付け');
            })
            .addExtraButton(button => {
                button.setIcon('eye').setTooltip('表示/非表示')
                    .onClick(() => {
                        const hidden = authTokenInputEl.type === 'password';
                        authTokenInputEl.type = hidden ? 'text' : 'password';
                        button.setIcon(hidden ? 'eye-off' : 'eye');
                    });
            });

        let ct0InputEl: HTMLInputElement;
        new Setting(containerEl)
            .setName('ct0 (CSRF Token)')
            .setDesc('CSRF トークン（推奨）')
            .addText(text => {
                text.inputEl.type = 'password';
                ct0InputEl = text.inputEl;
                text.setPlaceholder('ct0 の値を貼り付け');
            })
            .addExtraButton(button => {
                button.setIcon('eye').setTooltip('表示/非表示')
                    .onClick(() => {
                        const hidden = ct0InputEl.type === 'password';
                        ct0InputEl.type = hidden ? 'text' : 'password';
                        button.setIcon(hidden ? 'eye-off' : 'eye');
                    });
            });

        sessionStatusEl = containerEl.createDiv();
        sessionStatusEl.style.cssText = 'padding: 4px 0 12px; font-size: 13px;';
        sessionStatusEl.setText('● 状態を確認中...');

        new Setting(containerEl)
            .setName('Cookie を保存')
            .setDesc('入力した Cookie をサーバーに送信します')
            .addButton(button => {
                button
                    .setButtonText('保存する')
                    .setCta()
                    .onClick(async () => {
                        const authToken = authTokenInputEl.value.trim();
                        const ct0 = ct0InputEl.value.trim();
                        if (!authToken) {
                            new Notice('auth_token を入力してください');
                            return;
                        }
                        button.setButtonText('保存中...').setDisabled(true);
                        try {
                            await this.plugin.xClient.saveSessionCookies(authToken, ct0 || undefined);
                            sessionStatusEl.setText('● Cookie 設定済み ✅（投稿可能）');
                            sessionStatusEl.style.color = '#10b981';
                            authTokenInputEl.value = '';
                            ct0InputEl.value = '';
                            new Notice('Cookie を保存しました！投稿できるようになりました。');
                        } catch (err: any) {
                            sessionStatusEl.setText(`● エラー: ${err.message}`);
                            sessionStatusEl.style.color = '#ef4444';
                            new Notice(`Cookie の保存に失敗しました: ${err.message}`);
                        } finally {
                            button.setButtonText('保存する').setDisabled(false);
                        }
                    });
            });

        // connectBtn と sessionStatusEl が揃ったのでステータス確認
        this.checkInitialStatus(statusEl, connectBtn, sessionStatusEl);

        // ─── 動作設定 ───
        containerEl.createEl('h3', { text: '動作設定' });

        new Setting(containerEl)
            .setName('ヘッドレスモード')
            .setDesc('記事投稿時にブラウザを非表示で実行（推奨: ON）')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.headlessMode)
                .onChange(async (value) => {
                    this.plugin.settings = { ...this.plugin.settings, headlessMode: value };
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('投稿後に X.com を開く')
            .setDesc('投稿後にブラウザで X Articles を開く')
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

        // ─── 詳細設定 ───
        containerEl.createEl('h3', { text: '詳細設定' });

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
            .setName('サーバー接続テスト')
            .setDesc('ローカルサーバーとの接続を確認')
            .addButton(button => button
                .setButtonText('テスト')
                .onClick(async () => {
                    button.setButtonText('確認中...');
                    button.setDisabled(true);
                    const ok = await this.plugin.xClient.healthCheck();
                    button.setButtonText(ok ? '接続成功 ✅' : '接続失敗 ❌');
                    setTimeout(() => {
                        button.setButtonText('テスト');
                        button.setDisabled(false);
                    }, 2000);
                }));
    }

    private async checkInitialStatus(statusEl: HTMLElement, btn: ButtonComponent, sessionStatusEl: HTMLElement): Promise<void> {
        try {
            const status = await this.plugin.xClient.getOAuthStatus();
            this.applyStatusStyle(statusEl, status);
            this.applySessionStyle(sessionStatusEl, status);
            if (status.oauthConnected) {
                btn.setButtonText('再連携');
            }
        } catch {
            statusEl.setText('● サーバーに接続できません');
            statusEl.style.color = 'var(--text-muted)';
            sessionStatusEl.setText('● サーバーに接続できません');
            sessionStatusEl.style.color = 'var(--text-muted)';
        }
    }

    private applyStatusStyle(statusEl: HTMLElement, status: OAuthStatus): void {
        if (status.oauthConnected) {
            statusEl.setText('● Bearer トークン取得済み');
            statusEl.style.color = '#10b981';
        } else if (status.status === 'error' && status.error) {
            statusEl.setText(`● エラー: ${status.error}`);
            statusEl.style.color = '#ef4444';
        } else if (status.status === 'pending') {
            statusEl.setText('● ブラウザでログイン待機中...');
            statusEl.style.color = '#f59e0b';
        } else {
            statusEl.setText('● 未接続');
            statusEl.style.color = 'var(--text-muted)';
        }
    }

    private applySessionStyle(sessionStatusEl: HTMLElement, status: OAuthStatus): void {
        if (status.sessionReady) {
            sessionStatusEl.setText('● Cookie 設定済み ✅（投稿可能）');
            sessionStatusEl.style.color = '#10b981';
        } else {
            sessionStatusEl.setText('● 未設定（auth_token を入力してください）');
            sessionStatusEl.style.color = 'var(--text-muted)';
        }
    }

    private async startOAuthFlow(button: ButtonComponent, statusEl: HTMLElement): Promise<void> {
        const { clientId, clientSecret } = this.plugin.settings;

        if (!clientId) {
            new Notice('Client ID を入力してください');
            return;
        }

        const isServerUp = await this.plugin.xClient.healthCheck();
        if (!isServerUp) {
            new Notice('サーバーが起動していません。ターミナルで npm run server を実行してください。', 8000);
            return;
        }

        button.setButtonText('認証中...').setDisabled(true);
        statusEl.setText('● ブラウザでログインしてください...');
        statusEl.style.color = '#f59e0b';

        try {
            await this.plugin.xClient.startOAuth(clientId, clientSecret || undefined);
        } catch (err: any) {
            button.setButtonText('連携する').setDisabled(false);
            statusEl.setText(`● エラー: ${err.message}`);
            statusEl.style.color = '#ef4444';
            return;
        }

        this.pollingActive = true;
        await this.pollUntilComplete(button, statusEl);
    }

    private async pollUntilComplete(button: ButtonComponent, statusEl: HTMLElement): Promise<void> {
        const MAX_POLLS = 150; // 5 minutes (150 × 2s)
        let count = 0;

        while (this.pollingActive && count < MAX_POLLS) {
            await new Promise<void>(resolve => setTimeout(resolve, 2000));
            if (!this.pollingActive) break;
            count++;

            const status = await this.plugin.xClient.getOAuthStatus();

            if (status.oauthConnected || status.status === 'success') {
                this.pollingActive = false;
                button.setButtonText('再連携').setDisabled(false);
                statusEl.setText('● Bearer トークン取得済み');
                statusEl.style.color = '#10b981';
                if (status.sessionReady) {
                    new Notice('認証完了！投稿できるようになりました。', 5000);
                } else {
                    new Notice(
                        'OAuth 完了！\n次に「セッション Cookie 設定」へ：\n' +
                        'ブラウザで x.com を開いて DevTools（F12）→ Application → Cookies → auth_token と ct0 をコピーして貼り付けてください。',
                        15000
                    );
                }
                return;
            }

            if (status.status === 'error') {
                this.pollingActive = false;
                button.setButtonText('連携する').setDisabled(false);
                statusEl.setText(`● エラー: ${status.error || '不明なエラー'}`);
                statusEl.style.color = '#ef4444';
                return;
            }
        }

        // Timeout
        if (this.pollingActive) {
            this.pollingActive = false;
            button.setButtonText('連携する').setDisabled(false);
            statusEl.setText('● タイムアウト（再試行してください）');
            statusEl.style.color = '#ef4444';
        }
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
                    if (!checking) this.publishCurrentFile(file);
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
                    if (!checking) this.publishCurrentFile(file, true);
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

        try {
            await updateFrontmatter(this.app, file, { x_status: 'publishing', x_error: '' });
        } catch {}

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
                const updates: Record<string, any> = { x_status: 'published', x_error: '' };
                if (result.articleUrl) updates.x_url = result.articleUrl;

                const cache = this.app.metadataCache.getFileCache(file);
                if (!cache?.frontmatter?.x_publish_date) {
                    updates.x_publish_date = getTodayDate();
                }

                try { await updateFrontmatter(this.app, file, updates); } catch {}

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
            try { await updateFrontmatter(this.app, file, { x_status: 'review', x_error: errorMessage }); } catch {}

            this.handleError(error);
        }
    }

    getShortErrorMessage(error: any): string {
        const message = error.message || String(error);
        if (message.includes('ECONNREFUSED') || message.includes('fetch')) return 'サーバー接続失敗';
        if (message.includes('timeout')) return 'タイムアウト';
        if (message.includes('未連携') || message.includes('cookies')) return '認証エラー';
        if (message.length > 50) return message.substring(0, 47) + '...';
        return message;
    }

    handleError(error: any) {
        const message = error.message || String(error);
        let userMessage = 'X Article への投稿に失敗しました';

        if (message.includes('ECONNREFUSED') || message.includes('fetch')) {
            userMessage = `サーバーに接続できません。ターミナルで npm run server を実行し、プラグイン設定を確認してください。`;
        } else if (message.includes('未連携') || message.includes('cookies')) {
            userMessage = 'X アカウントが連携されていません。プラグイン設定から「X アカウントを連携」を実行してください。';
        } else if (message.includes('timeout')) {
            userMessage = 'タイムアウトしました。もう一度お試しください。';
        } else {
            userMessage = `エラー: ${message}`;
        }

        new Notice(userMessage, 10000);
    }
}
