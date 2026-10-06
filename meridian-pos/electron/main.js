'use strict';
/**
 * Meridian POS — desktop shell (Electron main process).
 *
 * Modes (userData/terminal.json):
 *   standalone (default) – runs the POS server in-process on 127.0.0.1 with its own SQLite database.
 *   client               – a lane that connects to a store server running elsewhere on the LAN
 *                          ("serverUrl": "http://192.168.1.10:4780").
 * Security: context isolation + sandbox, no Node in the renderer, navigation locked to the app origin,
 * all device permissions denied, only the whitelisted IPC below is exposed via preload.js.
 */
process.removeAllListeners('warning');
const { app, BrowserWindow, Menu, ipcMain, screen, shell, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let displayWindow = null;
let server = null;
let baseUrl = null;

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });

const terminalFile = () => path.join(app.getPath('userData'), 'terminal.json');
function readTerminal() {
  try { return JSON.parse(fs.readFileSync(terminalFile(), 'utf8')); } catch (_) { return { mode: 'standalone', registerId: '' }; }
}
function writeTerminal(t) { fs.mkdirSync(path.dirname(terminalFile()), { recursive: true }); fs.writeFileSync(terminalFile(), JSON.stringify(t, null, 2)); }

async function startBackend() {
  const t = readTerminal();
  if (t.mode === 'client' && t.serverUrl) { baseUrl = t.serverUrl.replace(/\/$/, ''); return; }
  const { start } = require('../server/app');
  const dataDir = process.env.POS_DATA || path.join(app.getPath('userData'), 'data');
  server = await start({ dataDir, port: Number(process.env.POS_PORT || 0), seed: process.env.POS_SEED || 'demo' });
  baseUrl = server.url;
}

function lockDown(win) {
  const allowed = (u) => { try { return new URL(u).origin === new URL(baseUrl).origin; } catch (_) { return false; } };
  win.webContents.on('will-navigate', (e, u) => { if (!allowed(u)) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (allowed(url) && new URL(url).pathname === '/display.html') { openDisplay(''); return { action: 'deny' }; }
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 700, backgroundColor: '#0d1520', show: false, title: 'Meridian POS',
    icon: path.join(__dirname, '..', 'app', 'assets', 'icon.svg'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  lockDown(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(baseUrl);
  mainWindow.on('closed', () => { mainWindow = null; if (displayWindow) displayWindow.close(); });
}

function openDisplay(token) {
  if (displayWindow) { displayWindow.focus(); return; }
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const second = displays.find((d) => d.id !== primary.id);
  const b = (second || primary).workArea;
  displayWindow = new BrowserWindow({
    x: b.x + (second ? 0 : 60), y: b.y + (second ? 0 : 60), width: second ? b.width : 1024, height: second ? b.height : 640, fullscreen: !!second, autoHideMenuBar: true, title: 'Customer display', backgroundColor: '#0d1520',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  lockDown(displayWindow);
  displayWindow.loadURL(`${baseUrl}/display.html${token ? `#token=${encodeURIComponent(token)}` : ''}`);
  displayWindow.on('closed', () => { displayWindow = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Terminal setup…', click: terminalSetup },
      { label: 'Open data folder', click: () => shell.openPath(process.env.POS_DATA || path.join(app.getPath('userData'), 'data')) },
      { label: 'Back up database now', click: () => { if (!server) return; const f = server.app.backup(); dialog.showMessageBox({ message: `Backup written:\n${f}` }); } },
      { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' }] },
    { label: 'View', submenu: [
      { label: 'Customer display', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.meridianOpenDisplay && window.meridianOpenDisplay()') },
      // F5 is a POS shortcut (recall), so reload uses Ctrl/Cmd+Shift+R only.
      { label: 'Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => mainWindow && mainWindow.reload() },
      { role: 'togglefullscreen', accelerator: 'F11' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      ...(process.env.POS_DEV ? [{ role: 'toggleDevTools' }] : [])] },
    { label: 'Help', submenu: [{ label: 'About Meridian POS', click: () => dialog.showMessageBox({ message: `Meridian POS ${app.getVersion()}\nServer: ${baseUrl}\nDatabase driver: ${server ? server.app.db.driverName : 'remote'}` }) }] },
  ]));
}

async function terminalSetup() {
  const t = readTerminal();
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'question', title: 'Terminal setup', message: `This terminal runs in ${t.mode === 'client' ? `client mode (${t.serverUrl})` : 'standalone mode (local database)'}.`,
    detail: 'Standalone: this computer keeps its own database (single-lane stores or offline-first lanes).\nClient: this lane uses a store server on the network (edit terminal.json: {"mode":"client","serverUrl":"http://host:4780"}).',
    buttons: ['OK', 'Open terminal.json'],
  });
  if (r.response === 1) { if (!fs.existsSync(terminalFile())) writeTerminal(t); shell.showItemInFolder(terminalFile()); }
}

// ── IPC (whitelisted) ──
ipcMain.on('terminal:get', (e) => { e.returnValue = readTerminal(); });
ipcMain.on('terminal:setRegister', (e, id) => { const t = readTerminal(); t.registerId = typeof id === 'string' ? id.slice(0, 64) : ''; writeTerminal(t); });
ipcMain.handle('display:open', (e, token) => openDisplay(typeof token === 'string' ? token : ''));
ipcMain.handle('print:html', async (e, htmlDoc, opts = {}) => {
  if (typeof htmlDoc !== 'string' || htmlDoc.length > 2_000_000) return false;
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
  await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlDoc)}`);
  return new Promise((resolve) => {
    w.webContents.print({ silent: !!opts.silent, printBackground: true, margins: { marginType: 'none' } }, (ok, reason) => { w.close(); resolve(ok ? true : reason); });
  });
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(false));
  try { await startBackend(); } catch (e) {
    dialog.showErrorBox('Meridian POS could not start', `${e.message}\n\nIf this is a fresh install, run "npm install" so the database driver is built for this Electron version.`);
    app.quit(); return;
  }
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting || !server) return;
  e.preventDefault(); quitting = true;
  try { server.app.backup(); } catch (_) { /* ignore */ }
  await server.close();
  app.quit();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
