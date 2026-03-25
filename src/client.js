import * as monaco from 'monaco-editor';
import { initialize as initServices } from '@codingame/monaco-vscode-api';
import { MonacoLanguageClient } from 'monaco-languageclient';
import { CloseAction, ErrorAction } from 'vscode-languageclient';
import { AbstractMessageReader, AbstractMessageWriter } from 'vscode-jsonrpc';
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override';
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override';
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override';
import getEditorServiceOverride from '@codingame/monaco-vscode-editor-service-override';
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override';
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override';
import getStorageServiceOverride from '@codingame/monaco-vscode-storage-service-override';
import getLifecycleServiceOverride from '@codingame/monaco-vscode-lifecycle-service-override';
import getEnvironmentServiceOverride from '@codingame/monaco-vscode-environment-service-override';
import getExtensionServiceOverride from '@codingame/monaco-vscode-extensions-service-override';
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override';
import getHostServiceOverride from '@codingame/monaco-vscode-host-service-override';
import getConfigurationServiceOverride, { initUserConfiguration } from '@codingame/monaco-vscode-configuration-service-override';
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override';
import getFilesServiceOverride, {
    initFile,
    RegisteredFileSystemProvider,
    RegisteredMemoryFile,
    registerFileSystemOverlay
} from '@codingame/monaco-vscode-files-service-override';
import { registerExtension } from '@codingame/monaco-vscode-api/extensions';
import '@codingame/monaco-vscode-theme-defaults-default-extension';
import 'vscode/localExtensionHost';
import { Emitter, Event } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event';
import { IWorkspacesService } from '@codingame/monaco-vscode-api/vscode/vs/platform/workspaces/common/workspaces.service';
import { SyncDescriptor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors';

// ─── Worker Setup ────────────────────────────────────────────────────────────

self.MonacoEnvironment = {
    getWorker: function (moduleId, label) {
        if (label === 'TextMateWorker') {
            return new Worker(
                new URL('@codingame/monaco-vscode-textmate-service-override/worker', import.meta.url),
                { type: 'module' }
            );
        }
        return new Worker(
            new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
            { type: 'module' }
        );
    }
};

// ─── Filesystem ───────────────────────────────────────────────────────────────

// Monaco only ever sees virtual paths under this root — real paths never exposed to the browser
const params = new URLSearchParams(window.location.search);
const workspaceName = params.get('name').replace(' ', '_') ?? "workspace";
const WORKSPACE_ROOT = `file:///${workspaceName}`;
const WORKSPACE_PATH = `/${workspaceName}`; // the path component of WORKSPACE_ROOT

function toRelativePath(uri) {
    const uriStr = uri.toString();
    if (uriStr.startsWith(WORKSPACE_ROOT)) {
        const relative = uri.path.replace(new RegExp(`^${WORKSPACE_PATH}/?`), '');
        return relative === '' ? '.' : relative;
    }

    const fsPath = uri.fsPath;
    if (fsPath.startsWith('/') && fsPath.indexOf('/', 1) === -1) {
        return fsPath.slice(1);
    }

    return fsPath;
}

function createDiskProvider() {
    const fileChangeEmitter = new Emitter();

    return {
        capabilities: 2, // FileReadWrite
        onDidChangeCapabilities: new Emitter().event,
        onDidChangeFile: fileChangeEmitter.event,

        watch() { return { dispose: () => { } }; },

        async stat(uri) {
            const path = toRelativePath(uri);
            const existsRaw = await window.fsExists(path);
            const exists = typeof existsRaw === 'string' ? JSON.parse(existsRaw) : existsRaw;
            if (!exists) {
                const err = new Error('file not found');
                err.code = 'EntryNotFound';
                throw err;
            }
            const isDirRaw = await window.fsIsDirectory(path);
            const isDir = typeof isDirRaw === 'string' ? JSON.parse(isDirRaw) : isDirRaw;
            const isExternal = !uri.toString().startsWith(WORKSPACE_ROOT);
            return {
                type: isDir ? 2 : 1, // 2 = Directory, 1 = File
                ctime: 0,
                mtime: Date.now(),
                size: 0,
                permissions: isExternal ? 1 : undefined // readonly for external files
            };
        },

        async readFile(uri) {
            const path = toRelativePath(uri);
            const content = await window.fsReadFile(path);
            return new TextEncoder().encode(content);
        },

        async writeFile(uri, content) {
            const path = toRelativePath(uri);
            const text = new TextDecoder().decode(content);
            await window.fsWriteFile(path, text);
        },

        async readdir(uri) {
            const path = toRelativePath(uri);
            const result = await window.fsReadDir(path);
            const entries = typeof result === 'string' ? JSON.parse(result) : result;
            return entries.map(e => [e.name, e.isDirectory ? 2 : 1]);
        },

        async mkdir(uri) {
            const path = toRelativePath(uri);
            await window.fsMkdir(path);
        },

        async delete(uri, opts) {
            const path = toRelativePath(uri);
            const recursive = opts?.recursive ?? false;
            await window.fsDelete(path, recursive.toString());
        },

        async rename(from, to, opts) {
            const fromPath = toRelativePath(from);
            const toPath = toRelativePath(to);
            await window.fsRename(fromPath, toPath);
        }
    };
}

// ─── LSP Bridge ──────────────────────────────────────────────────────────────

class HaxeBridgeReader extends AbstractMessageReader {
    constructor(cwd) {
        super();
        this._callback = null;
        const cwdForward = cwd.replace(/\\/g, '/').replace(/\/$/, '');
        // handle both encoded (c%3A) and plain (c:) drive letter formats
        const realUriEncoded = 'file:///' + cwdForward.replace(/^([A-Za-z]):/, (_, l) => l.toLowerCase() + '%3A');
        const realUriPlain = 'file:///' + cwdForward;

        window._lspReceive = (msg) => {
            if (this._callback) {
                const translated = msg
                    .replaceAll(realUriEncoded, WORKSPACE_ROOT)
                    .replaceAll(realUriPlain, WORKSPACE_ROOT);
                this._callback(JSON.parse(translated));
            }
        };
    }
    listen(callback) {
        this._callback = callback;
        return { dispose: () => { this._callback = null; } };
    }
}

class HaxeBridgeWriter extends AbstractMessageWriter {
    constructor(cwd) {
        super();
        this.cwdForward = 'file:///' + cwd.replace(/\\/g, '/').replace(/\/$/, '');
    }
    write(msg) {
        if (typeof window.lspSend === 'function') {
            const msgStr = JSON.stringify(msg)
                .replaceAll(WORKSPACE_ROOT, this.cwdForward);
            window.lspSend(msgStr);
        }
        return Promise.resolve();
    }
    end() { }
}

// ─── Haxe Language Registration ──────────────────────────────────────────────

async function preRegisterHaxeLanguage() {
    monaco.languages.register({
        id: 'haxe',
        extensions: ['.hx'],
        aliases: ['Haxe', 'haxe']
    });

    const { registerFileUrl } = registerExtension({
        name: 'haxe-language',
        publisher: 'haxe',
        version: '1.0.0',
        engines: { vscode: '*' },
        contributes: {
            grammars: [{
                language: 'haxe',
                scopeName: 'source.hx',
                path: './haxe.tmLanguage.json'
            }]
        }
    });

    const response = await fetch('/haxe.tmLanguage.json');
    const text = await response.text();
    registerFileUrl(
        './haxe.tmLanguage.json',
        URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    );
}

async function preRegisterHxmlLanguage() {
    monaco.languages.register({
        id: 'hxml',
        extensions: ['.hxml'],
        aliases: ['HXML', 'hxml']
    });

    const { registerFileUrl } = registerExtension({
        name: 'hxml-language',
        publisher: 'haxe',
        version: '1.0.0',
        contributes: {
            grammars: [{
                language: 'hxml',
                scopeName: 'source.hxml',
                path: './hxml.tmLanguage.json'
            }]
        }
    });

    try {
        const response = await fetch('/hxml.tmLanguage.json');
        if (!response.ok) {
            console.warn('[monaco] Missing /hxml.tmLanguage.json (status ' + response.status + '). Skipping HXML TextMate grammar.');
            return;
        }

        const text = await response.text();
        registerFileUrl(
            './hxml.tmLanguage.json',
            URL.createObjectURL(new Blob([text], { type: 'application/json' }))
        );
    } catch (e) {
        console.warn('[monaco] Failed to load HXML TextMate grammar:', e);
    }
}

async function preRegisterVsSetiIconTheme() {
    const { registerFileUrl } = registerExtension({
        name: 'theme-seti',
        publisher: 'vscode',
        version: '1.0.0',
        engines: { vscode: '*' },
        contributes: {
            iconThemes: [{
                id: 'vs-seti',
                label: 'Seti (Visual Studio Code)',
                path: './icons/vs-seti-icon-theme.json'
            }]
        }
    }, undefined, { system: true });

    // These assets are served from the monaco web server root:
    //   /vs-seti/icons/vs-seti-icon-theme.json
    //   /vs-seti/icons/seti.woff
    const themeUrl = new URL('/vs-seti/icons/vs-seti-icon-theme.json', window.location.href).toString();
    const fontUrl = new URL('/vs-seti/icons/seti.woff', window.location.href).toString();

    // Map the extension's internal paths to real URLs.
    // The icon theme JSON references `./seti.woff` (relative to itself),
    // which becomes `./icons/seti.woff` after resolution.
    registerFileUrl('./icons/vs-seti-icon-theme.json', themeUrl);
    registerFileUrl('./icons/seti.woff', fontUrl, 'font/woff');
}

function postRegisterHaxeLanguage() {
    monaco.languages.setLanguageConfiguration('haxe', {
        comments: { lineComment: '//', blockComment: ['/*', '*/'] },
        brackets: [['{', '}'], ['[', ']'], ['(', ')']],
        autoClosingPairs: [
            { open: '{', close: '}' }, { open: '[', close: ']' },
            { open: '(', close: ')' }, { open: '"', close: '"' },
            { open: "'", close: "'" }
        ],
        surroundingPairs: [
            { open: '{', close: '}' }, { open: '[', close: ']' },
            { open: '(', close: ')' }, { open: '"', close: '"' },
            { open: "'", close: "'" }
        ],
        indentationRules: {
            increaseIndentPattern: /^.*\{[^}"']*$/,
            decreaseIndentPattern: /^(.*\*\/)?\s*\}[;\s]*$/
        }
    });
}

function postRegisterHxmlLanguage() {
    // HXML syntax comment marker is commonly `#` (if your grammar uses something else,
    // you can tweak this without needing to change the TextMate grammar).
    monaco.languages.setLanguageConfiguration('hxml', {
        comments: { lineComment: '#' }
    });
}

// ─── Workspaces Service Stub ──────────────────────────────────────────────────

// Stubs out IWorkspacesService since we don't need recently opened files —
// the workspace is fixed per editor instance and managed by the host app.
class WorkspacesServiceStub {
    onDidChangeRecentlyOpened = Event.None;
    async getRecentlyOpened() { return { workspaces: [], files: [] }; }
    async addRecentlyOpened() { }
    async removeRecentlyOpened() { }
    async clearRecentlyOpened() { }
    async getDirtyWorkspaces() { return []; }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function waitForBridge() {
    return new Promise(resolve => {
        const check = setInterval(() => {
            if (typeof window.lspSend === 'function') {
                clearInterval(check);
                resolve();
            }
        }, 100);
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const cwd = params.get('cwd');
    const hxml = params.get('hxml');
    const cwdForward = cwd.replace(/\\/g, '/').replace(/\/$/, '');

    await preRegisterVsSetiIconTheme();
    await preRegisterHaxeLanguage();
    await preRegisterHxmlLanguage();

    const container = document.getElementById('workbench');

    // openEditor callback — handles all file open requests including go to definition
    async function openEditor(modelRef, options, sideBySide) {
        const uri = modelRef.object.textEditorModel.uri;
        // seed external files (stdlib, libraries) into filesystem as readonly
        if (!uri.toString().startsWith(WORKSPACE_ROOT)) {
            const content = await window.fsReadFile(uri.fsPath);
            const provider = new RegisteredFileSystemProvider(false);
            provider.registerFile(new RegisteredMemoryFile(uri, content));
            registerFileSystemOverlay(1, provider);
        }
        return undefined;
    }

    // seed workspace file and disk provider before services initialize
    const workspaceFileUri = monaco.Uri.file("/workspace.code-workspace");
    await initFile(workspaceFileUri, JSON.stringify({
        folders: [{ path: WORKSPACE_PATH }]
    }), { overwrite: true });

    await initUserConfiguration(JSON.stringify({
        'workbench.colorTheme': 'Default Dark Modern',
        'window.commandCenter': true,
        'window.menuBarVisibility': 'classic',
        'workbench.activityBar.location': 'default',
        'workbench.iconTheme': 'vs-seti',
        'window.title': `${workspaceName}\${separator}\${dirty}\${activeEditorShort}`,
        'files.exclude': {
            '*.code-workspace': true,
            '**/.vscode': true
        }
    }));

    // register disk provider before services so filesystem is ready on init
    registerFileSystemOverlay(1000, createDiskProvider());

    await initServices(
        {
            ...getModelServiceOverride(),
            ...getHostServiceOverride(),
            ...getFilesServiceOverride(),
            ...getEditorServiceOverride(openEditor),
            ...getWorkbenchServiceOverride(),
            ...getQuickAccessServiceOverride({
                isKeybindingConfigurationVisible: () => true,
                shouldUseGlobalPicker: () => true
            }),
            ...getStorageServiceOverride({
                fallbackOverride: {
                    'workbench.activity.showAccounts': false
                }
            }),
            ...getLifecycleServiceOverride(),
            ...getEnvironmentServiceOverride(),
            ...getExtensionServiceOverride(),
            ...getLanguagesServiceOverride(),
            ...getTextmateServiceOverride(),
            ...getThemeServiceOverride(),
            ...getConfigurationServiceOverride(monaco.Uri.parse(WORKSPACE_ROOT)),
            ...getExplorerServiceOverride(),
            [IWorkspacesService.toString()]: new SyncDescriptor(WorkspacesServiceStub, [], true)
        },
        container,
        { workspaceUri: workspaceFileUri },
        { userHome: monaco.Uri.file('/') }
    );

    postRegisterHaxeLanguage();
    postRegisterHxmlLanguage();

    // set up LSP after bridge is ready
    await waitForBridge();

    const reader = new HaxeBridgeReader(cwd);
    const writer = new HaxeBridgeWriter(cwd);

    const client = new MonacoLanguageClient({
        name: 'Haxe Language Client',
        clientOptions: {
            documentSelector: [{ language: 'haxe' }],
            workspaceFolder: {
                uri: monaco.Uri.file(cwdForward),
                name: workspaceName,
                index: 0
            },
            initializationOptions: {
                displayArguments: hxml ? [hxml] : [],
                displayPort: "auto"
            },
            errorHandler: {
                error: () => ({ action: ErrorAction.Continue }),
                closed: () => ({ action: CloseAction.DoNotRestart })
            }
        },
        messageTransports: { reader, writer }
    });

    client.start();

    client.sendNotification('workspace/didChangeConfiguration', {
        settings: {
            haxe: {
                displayPort: "auto",
                enableDiagnostics: true,
                enableCodeLens: true,
                buildCompletionCache: true,
                useLegacyCompletion: false,
                useLegacyDiagnostics: false
            }
        }
    });

    // save active file on Ctrl+S
    document.addEventListener('keydown', async (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();

            const activeEditor = monaco.editor.getActiveCodeEditor();
            if (activeEditor == null) return;

            const activeModel = activeEditor.getModel();
            if (activeModel == null) return;

            const uri = activeModel.uri;
            const content = activeModel.getValue();

            // only write workspace files — external stdlib files are readonly
            if (uri.toString().startsWith(WORKSPACE_ROOT)) {
                const relativePath = toRelativePath(uri);
                await window.fsWriteFile(relativePath, content);

                const markers = monaco.editor.getModelMarkers({ resource: uri });
                const owners = [...new Set(markers.map(m => m.owner))];
                owners.forEach(owner => monaco.editor.setModelMarkers(activeModel, owner, []));

                client.sendNotification('textDocument/didSave', {
                    textDocument: { uri: uri.toString() },
                    text: content
                });
            }
        }
    });
}

main().catch(console.error);