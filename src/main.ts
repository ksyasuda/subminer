/*
  mpv-yomitan - Yomitan integration for mpv
  Copyright (C) 2024 sudacode

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/
import {
  app,
  BrowserWindow,
  session,
  ipcMain,
  globalShortcut,
  shell,
  protocol,
  IpcMainEvent,
  Extension,
  Notification,
  nativeImage,
} from "electron";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "chrome-extension",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
]);

import * as path from "path";
import * as net from "net";
import * as http from "http";
import * as os from "os";
import * as fs from "fs";
import WebSocket from "ws";
import { MecabTokenizer } from "./mecab-tokenizer";
import { mergeTokens } from "./token-merger";
import { createWindowTracker, BaseWindowTracker } from "./window-trackers";
import {
  Config,
  SubtitleData,
  SubtitlePosition,
  Keybinding,
  WindowGeometry,
} from "./types";
import { SubtitleTimingTracker } from "./subtitle-timing-tracker";
import { AnkiIntegration } from "./anki-integration";

const MPV_SOCKET_PATH = "/tmp/mpv-yomitan-socket";
const TEXTHOOKER_PORT = 5174;
const DEFAULT_WEBSOCKET_PORT = 6677;
let texthookerServer: http.Server | null = null;
let subtitleWebSocketServer: WebSocket.Server | null = null;
const USER_DATA_PATH = path.join(
  os.homedir(),
  ".config",
  "mpv-yomitan-overlay",
);
const isDev = process.argv.includes("--dev");

if (!fs.existsSync(USER_DATA_PATH)) {
  fs.mkdirSync(USER_DATA_PATH, { recursive: true });
}
app.setPath("userData", USER_DATA_PATH);

process.on("SIGINT", () => {
  app.quit();
});
process.on("SIGTERM", () => {
  app.quit();
});

let mainWindow: BrowserWindow | null = null;
let yomitanExt: Extension | null = null;
let yomitanSettingsWindow: BrowserWindow | null = null;
let mpvClient: MpvIpcClient | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentSubText = "";
let subVisibility = true;
let windowTracker: BaseWindowTracker | null = null;
let subtitlePosition: SubtitlePosition | null = null;
let mecabTokenizer: MecabTokenizer | null = null;
let keybindings: Keybinding[] = [];
let subtitleTimingTracker: SubtitleTimingTracker | null = null;
let ankiIntegration: AnkiIntegration | null = null;

const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { key: "Space", command: ["cycle", "pause"] },
];

const CONFIG_FILE = path.join(
  os.homedir(),
  ".config",
  "mpv-yomitan-overlay",
  "config.json",
);

interface LoadConfigResult {
  success: boolean;
  config: Config;
}

function loadConfig(): LoadConfigResult {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf-8");
      return { success: true, config: JSON.parse(data) as Config };
    }
    return { success: true, config: {} };
  } catch (err) {
    console.error("Failed to load config:", (err as Error).message);
    return { success: false, config: {} };
  }
}

function saveConfig(config: Config): void {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error("Failed to save config:", (err as Error).message);
  }
}

function getTexthookerPath(): string | null {
  const searchPaths = [
    path.join(__dirname, "..", "vendor", "texthooker-ui", "docs"),
    path.join(process.resourcesPath, "app", "vendor", "texthooker-ui", "docs"),
  ];
  for (const p of searchPaths) {
    if (fs.existsSync(path.join(p, "index.html"))) {
      return p;
    }
  }
  return null;
}

function startTexthookerServer(): http.Server | null {
  const texthookerPath = getTexthookerPath();
  if (!texthookerPath) {
    console.error("texthooker-ui not found");
    return null;
  }

  texthookerServer = http.createServer((req, res) => {
    let urlPath = (req.url || "/").split("?")[0];
    let filePath = path.join(
      texthookerPath,
      urlPath === "/" ? "index.html" : urlPath,
    );

    const ext = path.extname(filePath);
    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ttf": "font/ttf",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
      res.end(data);
    });
  });

  texthookerServer.listen(TEXTHOOKER_PORT, "127.0.0.1", () => {
    console.log(
      `Texthooker server running at http://127.0.0.1:${TEXTHOOKER_PORT}`,
    );
  });

  return texthookerServer;
}

function stopTexthookerServer(): void {
  if (texthookerServer) {
    texthookerServer.close();
    texthookerServer = null;
  }
}

function hasMpvWebsocket(): boolean {
  const mpvWebsocketPath = path.join(os.homedir(), ".config", "mpv", "mpv_websocket");
  return fs.existsSync(mpvWebsocketPath);
}

function startSubtitleWebSocketServer(port: number): void {
  subtitleWebSocketServer = new WebSocket.Server({ port, host: "127.0.0.1" });

  subtitleWebSocketServer.on("connection", (ws: WebSocket) => {
    console.log("WebSocket client connected");
    if (currentSubText) {
      ws.send(JSON.stringify({ sentence: currentSubText }));
    }
  });

  subtitleWebSocketServer.on("error", (err: Error) => {
    console.error("WebSocket server error:", err.message);
  });

  console.log(`Subtitle WebSocket server running on ws://127.0.0.1:${port}`);
}

function broadcastSubtitle(text: string): void {
  if (!subtitleWebSocketServer) return;
  const message = JSON.stringify({ sentence: text });
  for (const client of subtitleWebSocketServer.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function stopSubtitleWebSocketServer(): void {
  if (subtitleWebSocketServer) {
    subtitleWebSocketServer.close();
    subtitleWebSocketServer = null;
  }
}

function loadSubtitlePosition(): SubtitlePosition | null {
  const { config } = loadConfig();
  const saved = config.subtitlePosition;

  if (saved && saved.yPercent !== undefined) {
    subtitlePosition = saved;
  } else {
    subtitlePosition = null;
  }

  return subtitlePosition;
}

function saveSubtitlePosition(position: SubtitlePosition): void {
  subtitlePosition = position;
  const { success, config } = loadConfig();
  if (!success) {
    console.error("Refusing to save - could not load existing config");
    return;
  }
  config.subtitlePosition = position;
  saveConfig(config);
}

function loadKeybindings(): Keybinding[] {
  const { config } = loadConfig();
  const userBindings = config.keybindings || [];

  const bindingMap = new Map<string, string[] | null>();

  for (const binding of DEFAULT_KEYBINDINGS) {
    bindingMap.set(binding.key, binding.command);
  }

  for (const binding of userBindings) {
    if (binding.command === null) {
      bindingMap.delete(binding.key);
    } else {
      bindingMap.set(binding.key, binding.command);
    }
  }

  keybindings = [];
  for (const [key, command] of bindingMap) {
    if (command !== null) {
      keybindings.push({ key, command });
    }
  }

  return keybindings;
}

const isStartCommand = process.argv.includes("--start");
const isHelpCommand = process.argv.includes("--help");
const autoStartOverlay = process.argv.includes("--auto-start-overlay");
console.log("CLI arguments:", process.argv);

function getBackendOverride(): string | undefined {
  const backendIndex = process.argv.indexOf("--backend");
  if (backendIndex !== -1 && process.argv[backendIndex + 1]) {
    const backend = process.argv[backendIndex + 1];
    console.log(`Backend override from CLI: ${backend}`);
    return backend;
  }
  return undefined;
}
const backendOverride = getBackendOverride();

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    handleCliCommand(argv);
  });

  if (!isStartCommand && !isHelpCommand) {
    console.error("No running instance. Use --start to launch the app.");
    app.quit();
  }
}

function handleCliCommand(argv: string[]): void {
  if (argv.includes("--stop")) {
    console.log("Stopping mpv-yomitan-overlay...");
    app.quit();
  } else if (argv.includes("--toggle")) {
    if (mpvClient && mpvClient.connected) {
      mpvClient.toggleSubVisibility();
    }
  } else if (argv.includes("--settings") || argv.includes("--yomitan")) {
    setTimeout(() => {
      openYomitanSettings();
    }, 1000);
  } else if (argv.includes("--show")) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  } else if (argv.includes("--hide")) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  } else if (argv.includes("--texthooker")) {
    if (!texthookerServer) {
      startTexthookerServer();
    }
    const { config } = loadConfig();
    const openBrowser = config.texthooker?.openBrowser !== false;
    if (openBrowser) {
      shell.openExternal(`http://127.0.0.1:${TEXTHOOKER_PORT}`);
    }
    console.log(`Texthooker available at http://127.0.0.1:${TEXTHOOKER_PORT}`);
  } else if (argv.includes("--help")) {
    console.log(`
mpv-yomitan-overlay CLI commands:
  --start             Start the overlay app (required for first launch)
  --stop              Stop the running overlay app
  --toggle            Toggle subtitle overlay visibility
  --settings          Open Yomitan settings window
  --texthooker        Start texthooker server and open browser
  --show              Force show overlay
  --hide              Force hide overlay
  --backend <type>    Window tracker backend: auto, hyprland, sway, x11
  --auto-start-overlay  Auto-hide mpv subtitles on connect (show overlay)
  --dev               Run in development mode
  --help              Show this help
`);
    if (!mainWindow) app.quit();
  }
}

function handleInitialArgs(): void {
  handleCliCommand(process.argv);
}

interface MpvMessage {
  event?: string;
  name?: string;
  data?: unknown;
  request_id?: number;
}

class MpvIpcClient {
  private socketPath: string;
  public socket: net.Socket | null = null;
  private buffer = "";
  public connected = false;
  public currentVideoPath = "";
  public currentTimePos = 0;
  public currentSubStart = 0;
  public currentSubEnd = 0;
  public currentSubText = "";

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  connect(): void {
    if (this.socket) {
      this.socket.destroy();
    }

    this.socket = new net.Socket();

    this.socket.on("connect", () => {
      console.log("Connected to MPV socket");
      this.connected = true;
      this.subscribeToProperties();
      this.getInitialState();

      const shouldAutoStart = autoStartOverlay || (loadConfig().config.auto_start_overlay !== false);
      if (shouldAutoStart) {
        console.log("Auto-starting overlay, hiding mpv subtitles");
        setTimeout(() => {
          this.setSubVisibility(false);
        }, 100);
      }
    });

    this.socket.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.socket.on("error", (err: Error) => {
      console.error("MPV socket error:", err.message);
      this.connected = false;
    });

    this.socket.on("close", () => {
      console.log("MPV socket closed");
      this.connected = false;
      this.scheduleReconnect();
    });

    this.socket.connect(this.socketPath);
  }

  private scheduleReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    reconnectTimer = setTimeout(() => {
      console.log("Attempting to reconnect to MPV...");
      this.connect();
    }, 2000);
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as MpvMessage;
        this.handleMessage(msg);
      } catch (e) {
        console.error("Failed to parse MPV message:", line, e);
      }
    }
  }

  private async handleMessage(msg: MpvMessage): Promise<void> {
    if (msg.event === "property-change") {
      if (msg.name === "sub-text") {
        currentSubText = (msg.data as string) || "";
        this.currentSubText = currentSubText;
        if (subtitleTimingTracker && this.currentSubStart !== undefined && this.currentSubEnd !== undefined) {
          subtitleTimingTracker.recordSubtitle(currentSubText, this.currentSubStart, this.currentSubEnd);
        }
        broadcastSubtitle(currentSubText);
        if (mainWindow && !mainWindow.isDestroyed()) {
          const subtitleData = await tokenizeSubtitle(currentSubText);
          mainWindow.webContents.send("subtitle:set", subtitleData);
        }
      } else if (msg.name === "sub-visibility") {
        subVisibility = msg.data === true || msg.data === "yes";
        console.log(
          "sub-visibility changed:",
          msg.data,
          "-> subVisibility:",
          subVisibility,
        );
        updateOverlayVisibility();
      } else if (msg.name === "sub-start") {
        this.currentSubStart = (msg.data as number) || 0;
      } else if (msg.name === "sub-end") {
        this.currentSubEnd = (msg.data as number) || 0;
      } else if (msg.name === "time-pos") {
        this.currentTimePos = (msg.data as number) || 0;
      } else if (msg.name === "path") {
        this.currentVideoPath = (msg.data as string) || "";
      }
    } else if (msg.data !== undefined && msg.request_id) {
      if (msg.request_id === 100) {
        subVisibility = msg.data === true || msg.data === "yes";
        updateOverlayVisibility();
      } else if (msg.request_id === 101) {
        currentSubText = (msg.data as string) || "";
        if (mpvClient) {
          mpvClient.currentSubText = currentSubText;
        }
        broadcastSubtitle(currentSubText);
        if (mainWindow && !mainWindow.isDestroyed()) {
          tokenizeSubtitle(currentSubText).then((subtitleData) => {
            mainWindow!.webContents.send("subtitle:set", subtitleData);
          });
        }
      }
    }
  }

  send(command: { command: unknown[]; request_id?: number }): boolean {
    if (!this.connected || !this.socket) {
      return false;
    }
    const msg = JSON.stringify(command) + "\n";
    this.socket.write(msg);
    return true;
  }

  private subscribeToProperties(): void {
    this.send({ command: ["observe_property", 1, "sub-text"] });
    this.send({ command: ["observe_property", 2, "sub-visibility"] });
    this.send({ command: ["observe_property", 3, "sub-start"] });
    this.send({ command: ["observe_property", 4, "sub-end"] });
    this.send({ command: ["observe_property", 5, "time-pos"] });
    this.send({ command: ["observe_property", 6, "path"] });
  }

  private getInitialState(): void {
    this.send({ command: ["get_property", "sub-visibility"], request_id: 100 });
    this.send({ command: ["get_property", "sub-text"], request_id: 101 });
  }

  toggleSubVisibility(): void {
    console.log("Sending sub-visibility toggle to MPV");
    this.send({ command: ["cycle", "sub-visibility"] });
  }

  setSubVisibility(visible: boolean): void {
    this.send({ command: ["set_property", "sub-visibility", visible ? "yes" : "no"] });
  }
}


async function tokenizeSubtitle(text: string): Promise<SubtitleData> {
  if (!text || !mecabTokenizer) {
    return { text, tokens: null };
  }

  const normalizedText = text
    .replace(/\\N/g, ' ')
    .replace(/\\n/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalizedText) {
    return { text, tokens: null };
  }

  try {
    const rawTokens = await mecabTokenizer.tokenize(normalizedText);

    if (rawTokens && rawTokens.length > 0) {
      const mergedTokens = mergeTokens(rawTokens);
      return { text: normalizedText, tokens: mergedTokens };
    }
  } catch (err) {
    console.error("Tokenization error:", (err as Error).message);
  }

  return { text, tokens: null };
}

function updateOverlayBounds(geometry: WindowGeometry): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!geometry) return;

  mainWindow.setBounds({
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
  });
}

function updateOverlayVisibility(): void {
  console.log("updateOverlayVisibility called, subVisibility:", subVisibility);
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.log("mainWindow not available");
    return;
  }

  if (subVisibility) {
    console.log("Hiding overlay (subs visible)");
    mainWindow.hide();
  } else {
    console.log(
      "Should show overlay, isTracking:",
      windowTracker?.isTracking(),
    );
    if (windowTracker && windowTracker.isTracking()) {
      const geometry = windowTracker.getGeometry();
      console.log("Geometry:", geometry);
      if (geometry) {
        updateOverlayBounds(geometry);
      }
      console.log("Showing mainWindow");
      mainWindow.show();
      mainWindow.focus();
    } else if (!windowTracker) {
      mainWindow.show();
      mainWindow.focus();
    }
  }
}

function ensureExtensionCopy(sourceDir: string): string {
  if (process.platform !== "linux") {
    return sourceDir;
  }

  const extensionsRoot = path.join(USER_DATA_PATH, "extensions");
  const targetDir = path.join(extensionsRoot, "yomitan");

  const sourceManifest = path.join(sourceDir, "manifest.json");
  const targetManifest = path.join(targetDir, "manifest.json");

  let shouldCopy = !fs.existsSync(targetDir);
  if (!shouldCopy && fs.existsSync(sourceManifest) && fs.existsSync(targetManifest)) {
    try {
      const sourceVersion = (JSON.parse(fs.readFileSync(sourceManifest, "utf-8")) as { version: string }).version;
      const targetVersion = (JSON.parse(fs.readFileSync(targetManifest, "utf-8")) as { version: string }).version;
      shouldCopy = sourceVersion !== targetVersion;
    } catch (e) {
      shouldCopy = true;
    }
  }

  if (shouldCopy) {
    fs.mkdirSync(extensionsRoot, { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    console.log(`Copied yomitan extension to ${targetDir}`);
  }

  return targetDir;
}

async function loadYomitanExtension(): Promise<Extension | null> {
  const searchPaths = [
    path.join(__dirname, "..", "vendor", "yomitan"),
    path.join(process.resourcesPath, "yomitan"),
    "/usr/share/mpv-yomitan-overlay/yomitan",
    path.join(USER_DATA_PATH, "yomitan"),
  ];

  let extPath: string | null = null;
  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      extPath = p;
      break;
    }
  }

  console.log("Yomitan search paths:", searchPaths);
  console.log("Found Yomitan at:", extPath);

  if (!extPath) {
    console.error("Yomitan extension not found in any search path");
    console.error("Install Yomitan to one of:", searchPaths);
    return null;
  }

  extPath = ensureExtensionCopy(extPath);
  console.log("Using extension path:", extPath);

  try {
    const extensions = session.defaultSession.extensions;
    if (extensions) {
      yomitanExt = await extensions.loadExtension(extPath, {
        allowFileAccess: true,
      });
    } else {
      yomitanExt = await session.defaultSession.loadExtension(extPath, {
        allowFileAccess: true,
      });
    }
    console.log("Yomitan extension loaded successfully:", yomitanExt.id);
    return yomitanExt;
  } catch (err) {
    console.error("Failed to load Yomitan extension:", (err as Error).message);
    console.error("Full error:", err);
    return null;
  }
}

function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  const htmlPath = path.join(__dirname, "renderer", "index.html");
  console.log("Loading HTML from:", htmlPath);
  console.log("HTML file exists:", fs.existsSync(htmlPath));

  mainWindow.loadFile(htmlPath).catch((err) => {
    console.error("Failed to load HTML file:", err);
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("Page failed to load:", errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("Overlay HTML loaded successfully");
  });

  mainWindow.hide();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  return mainWindow;
}

function openYomitanSettings(): void {
  console.log("openYomitanSettings called");

  if (!yomitanExt) {
    console.error("Yomitan extension not loaded - yomitanExt is:", yomitanExt);
    console.error(
      "This may be due to Manifest V3 service worker issues with Electron",
    );
    return;
  }

  if (yomitanSettingsWindow && !yomitanSettingsWindow.isDestroyed()) {
    console.log("Settings window already exists, focusing");
    yomitanSettingsWindow.focus();
    return;
  }

  console.log("Creating new settings window for extension:", yomitanExt.id);

  yomitanSettingsWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      session: session.defaultSession,
    },
  });

  const settingsUrl = `chrome-extension://${yomitanExt.id}/settings.html`;
  console.log("Loading settings URL:", settingsUrl);

  let loadAttempts = 0;
  const maxAttempts = 3;

  function attemptLoad(): void {
    yomitanSettingsWindow!.loadURL(settingsUrl).then(() => {
      console.log("Settings URL loaded successfully");
    }).catch((err: Error) => {
      console.error("Failed to load settings URL:", err);
      loadAttempts++;
      if (loadAttempts < maxAttempts && yomitanSettingsWindow && !yomitanSettingsWindow.isDestroyed()) {
        console.log(`Retrying in 500ms (attempt ${loadAttempts + 1}/${maxAttempts})`);
        setTimeout(attemptLoad, 500);
      }
    });
  }

  attemptLoad();

  yomitanSettingsWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription) => {
      console.error(
        "Settings page failed to load:",
        errorCode,
        errorDescription,
      );
    },
  );

  yomitanSettingsWindow.webContents.on("did-finish-load", () => {
    console.log("Settings page loaded successfully");
  });

  setTimeout(() => {
    if (yomitanSettingsWindow && !yomitanSettingsWindow.isDestroyed()) {
      yomitanSettingsWindow.setSize(
        yomitanSettingsWindow.getSize()[0],
        yomitanSettingsWindow.getSize()[1],
      );
      yomitanSettingsWindow.webContents.invalidate();
      yomitanSettingsWindow.show();
    }
  }, 500);

  yomitanSettingsWindow.on("closed", () => {
    yomitanSettingsWindow = null;
  });
}

function registerGlobalShortcuts(): void {
  globalShortcut.register("Alt+Shift+O", () => {
    console.log(
      "Toggle shortcut pressed, mpvClient connected:",
      mpvClient?.connected,
    );
    if (mpvClient && mpvClient.connected) {
      mpvClient.toggleSubVisibility();
    } else {
      console.log("MPV client not connected, cannot toggle");
    }
  });

  globalShortcut.register("Alt+Shift+Y", () => {
    openYomitanSettings();
  });

  if (isDev) {
    globalShortcut.register("F12", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.toggleDevTools();
      }
    });
  }
}

ipcMain.on("set-ignore-mouse-events", (_event: IpcMainEvent, ignore: boolean, options: { forward?: boolean } = {}) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(ignore, options);
  }
});

ipcMain.on("open-yomitan-settings", () => {
  openYomitanSettings();
});

ipcMain.handle("get-sub-visibility", () => {
  return subVisibility;
});

ipcMain.handle("get-current-subtitle", async () => {
  return await tokenizeSubtitle(currentSubText);
});

ipcMain.handle("get-subtitle-position", () => {
  return subtitlePosition;
});

ipcMain.on("save-subtitle-position", (_event: IpcMainEvent, position: SubtitlePosition) => {
  saveSubtitlePosition(position);
});

ipcMain.handle("get-mecab-status", () => {
  if (mecabTokenizer) {
    return mecabTokenizer.getStatus();
  }
  return { available: false, enabled: false, path: null };
});

ipcMain.on("set-mecab-enabled", (_event: IpcMainEvent, enabled: boolean) => {
  if (mecabTokenizer) {
    mecabTokenizer.setEnabled(enabled);
  }
});

ipcMain.on("mpv-command", (_event: IpcMainEvent, command: string[]) => {
  if (mpvClient && mpvClient.connected) {
    mpvClient.send({ command });
  }
});

ipcMain.handle("get-keybindings", () => {
  return keybindings;
});

ipcMain.handle("get-anki-connect-status", () => {
  return ankiIntegration !== null;
});

/**
 * Create and show a desktop notification with robust icon handling.
 * Supports both file paths (preferred on Linux/Wayland) and data URLs (fallback).
 */
function showDesktopNotification(title: string, options: { body?: string; icon?: string }): void {
  const notificationOptions: { title: string; body?: string; icon?: Electron.NativeImage | string } = { title };

  if (options.body) {
    notificationOptions.body = options.body;
  }

  if (options.icon) {
    // Check if it's a file path (starts with / on Linux/Mac, or drive letter on Windows)
    const isFilePath = typeof options.icon === 'string' &&
      (options.icon.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(options.icon));

    if (isFilePath) {
      // File path - preferred for Linux/Wayland compatibility
      // Verify file exists before using
      if (fs.existsSync(options.icon)) {
        notificationOptions.icon = options.icon;
      } else {
        console.warn('Notification icon file not found:', options.icon);
      }
    } else if (typeof options.icon === 'string' && options.icon.startsWith('data:image/')) {
      // Data URL fallback - decode to nativeImage
      const base64Data = options.icon.replace(/^data:image\/\w+;base64,/, '');
      try {
        const image = nativeImage.createFromBuffer(Buffer.from(base64Data, 'base64'));
        if (image.isEmpty()) {
          console.warn('Notification icon created from base64 is empty - image format may not be supported by Electron');
        } else {
          notificationOptions.icon = image;
        }
      } catch (err) {
        console.error('Failed to create notification icon from base64:', err);
      }
    } else {
      // Unknown format, try to use as-is
      notificationOptions.icon = options.icon;
    }
  }

  const notification = new Notification(notificationOptions);
  notification.show();
}

ipcMain.on("set-anki-connect-enabled", (_event: IpcMainEvent, enabled: boolean) => {
  const { config } = loadConfig();
  if (!config.ankiConnect) {
    config.ankiConnect = {};
  }
  config.ankiConnect.enabled = enabled;
  saveConfig(config);

  if (enabled && !ankiIntegration && subtitleTimingTracker && mpvClient) {
    ankiIntegration = new AnkiIntegration(
      config.ankiConnect,
      subtitleTimingTracker,
      mpvClient,
      (text: string) => {
        if (mpvClient) {
          mpvClient.send({
            command: ["show-text", text, "3000"],
          });
        }
      },
      showDesktopNotification,
    );
    ankiIntegration.start();
    console.log("AnkiConnect integration enabled");
  } else if (!enabled && ankiIntegration) {
    ankiIntegration.destroy();
    ankiIntegration = null;
    console.log("AnkiConnect integration disabled");
  }
});

ipcMain.on("clear-anki-connect-history", () => {
  if (subtitleTimingTracker) {
    subtitleTimingTracker.cleanup();
    console.log("AnkiConnect subtitle timing history cleared");
  }
});

app.whenReady().then(async () => {
  loadSubtitlePosition();
  loadKeybindings();

  mecabTokenizer = new MecabTokenizer();
  await mecabTokenizer.checkAvailability();

  subtitleTimingTracker = new SubtitleTimingTracker();

  await loadYomitanExtension();
  createMainWindow();
  registerGlobalShortcuts();

  windowTracker = createWindowTracker(backendOverride);
  if (windowTracker) {
    windowTracker.onGeometryChange = (geometry: WindowGeometry) => {
      updateOverlayBounds(geometry);
    };
    windowTracker.onWindowFound = (geometry: WindowGeometry) => {
      console.log("MPV window found:", geometry);
      updateOverlayBounds(geometry);
      if (!subVisibility) {
        updateOverlayVisibility();
      }
    };
    windowTracker.onWindowLost = () => {
      console.log("MPV window lost");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
      }
    };
    windowTracker.start();
  }

  mpvClient = new MpvIpcClient(MPV_SOCKET_PATH);
  mpvClient.connect();

  const { config } = loadConfig();
  const wsConfig = config.websocket || {};
  const wsEnabled = wsConfig.enabled ?? "auto";
  const wsPort = wsConfig.port || DEFAULT_WEBSOCKET_PORT;

  if (wsEnabled === true || (wsEnabled === "auto" && !hasMpvWebsocket())) {
    startSubtitleWebSocketServer(wsPort);
  } else if (wsEnabled === "auto") {
    console.log("mpv_websocket detected, skipping built-in WebSocket server");
  }

  if (config.ankiConnect?.enabled && subtitleTimingTracker && mpvClient) {
    ankiIntegration = new AnkiIntegration(
      config.ankiConnect,
      subtitleTimingTracker,
      mpvClient,
      (text: string) => {
        if (mpvClient) {
          mpvClient.send({
            command: ["show-text", text, "3000"],
          });
        }
      },
      showDesktopNotification,
    );
    ankiIntegration.start();
  }

  handleInitialArgs();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopSubtitleWebSocketServer();
  stopTexthookerServer();
  if (windowTracker) {
    windowTracker.stop();
  }
  if (mpvClient && mpvClient.socket) {
    mpvClient.socket.destroy();
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  if (subtitleTimingTracker) {
    subtitleTimingTracker.destroy();
  }
  if (ankiIntegration) {
    ankiIntegration.destroy();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
