let view;

const { app, BrowserWindow, BrowserView, Menu, Tray, session, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const { ElectronBlocker } = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');
const Store = require('electron-store');
const AutoLaunch = require('auto-launch');
const axios = require('axios');
const cheerio = require('cheerio');
const DiscordRPC = require('discord-rpc');

const DISCORD_CLIENT_ID = '1477971683708108854';

const store = new Store({
  defaults: {
    miniMode: false,
    autoLaunch: false,
    volumeBoost: 1.0
  }
});

const autoLauncher = new AutoLaunch({
  name: 'SoundCloud Electron',
  isHidden: true
});

let tray = null;
let win = null;
let geniusWindow = null;
let trackMonitoringInterval = null;
let currentTrack = { title: null, artist: null, artworkUrl: null, isPlaying: false };
let originalWindowBounds = { width: 1200, height: 800 };
let currentTrackName = '';
const rpc = new DiscordRPC.Client({ transport: 'ipc' });
let rpcConnected = false;
let rpcReconnectTimeout = null;

app.isQuitting = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function bringMainWindowToFront() {
  if (!win || win.isDestroyed()) return;

  if (win.isMinimized()) {
    win.restore();
  }

  if (!win.isVisible()) {
    win.show();
  }

  win.focus();
}

app.on('second-instance', () => {
  bringMainWindowToFront();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  cleanup();
});

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 796,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin'
      ? {
          titleBarOverlay: {
            color: '#121212',
            symbolColor: '#CCCCCC'
          }
        }
      : {}),
    icon: 'assets/icon.ico',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  originalWindowBounds = { width: 1200, height: 800 };
  Menu.setApplicationMenu(null);
  win.loadFile('index.html');

  view = new BrowserView({
    webPreferences: {
      contextIsolation: true
    }
  });

  const TOP_BAR_HEIGHT = 40;
  function resizeView() {
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: TOP_BAR_HEIGHT, width, height: height - TOP_BAR_HEIGHT });
  }
  win.on('resize', resizeView);
  win.on('enter-full-screen', resizeView);
  win.on('leave-full-screen', resizeView);
  resizeView();

  win.setBrowserView(view);
  view.setBounds({ x: 0, y: 40, width: 1200, height: 757 });
  view.webContents.loadURL('https://soundcloud.com');

  win.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      win.hide();
      return false;
    }
    return true;
  });

  ipcMain.handle('nav:back', () => {
    if (view && !view.webContents.isDestroyed() && view.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack();
    }
  });

  ipcMain.handle('nav:forward', () => {
    if (view && !view.webContents.isDestroyed() && view.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward();
    }
  });

  ipcMain.handle('nav:reload', () => {
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.reload();
    }
  });

  ipcMain.handle('genius:toggle-window', () => {
    toggleGeniusWindow();
    return { ok: true };
  });

  ipcMain.handle('genius:close-now', () => {
    if (geniusWindow && !geniusWindow.isDestroyed()) {
      geniusWindow.close();
    }
    return { ok: true };
  });

  view.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      view.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  view.webContents.on('did-finish-load', () => {
    view.webContents.insertCSS('::-webkit-scrollbar { display: none; }');

    view.webContents.executeJavaScript(`
      const removeElements = () => {
        const selectors = [
          '.header__upsellWrapper.left',
          '.l-product-banners.l-inner-fullwidth',
          'div.trackMonetizationSidebarUpsell.sc-background-light.sc-pt-5x.sc-pb-2x.sc-px-2x.sc-mb-3x.sc-mx-1x',
          'div.quotaMeterWrapper',
          'article.sidebarModule.g-all-transitions-200-linear.mobileApps'
        ];

        selectors.forEach((sel) => {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        });

        document.querySelectorAll('div.sidebarModule').forEach((el) => {
          el.style.display = 'none';
        });
      };

      removeElements();

      const observer = new MutationObserver(() => {
        removeElements();
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    `);

    injectVolumeBoostHook();
    startTrackMonitoring();
  });

  createTray(win);

  if (store.get('miniMode')) {
    setTimeout(() => {
      applyMiniMode();
    }, 500);
  }
}

function executeMediaControl(selectorList) {
  if (!view || view.webContents.isDestroyed()) return;

  const js = `
    (() => {
      const selectors = ${JSON.stringify(selectorList)};
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          el.click();
          return true;
        }
      }
      return false;
    })();
  `;

  view.webContents.executeJavaScript(js).catch(() => {});
}

function registerGlobalShortcuts() {
  try {
    globalShortcut.unregisterAll();

    globalShortcut.register('MediaPlayPause', () => {
      executeMediaControl(['.playControls__play', '.playControl']);
    });

    globalShortcut.register('MediaNextTrack', () => {
      executeMediaControl(['.skipControl__next']);
    });

    globalShortcut.register('MediaPreviousTrack', () => {
      executeMediaControl(['.skipControl__previous']);
    });
  } catch (err) {
    // Keep silent: some systems reserve media keys.
  }
}

function connectDiscordRPC() {
  if (app.isQuitting || rpcConnected || connectDiscordRPC._loginInFlight) return;

  const scheduleReconnect = () => {
    if (app.isQuitting) return;
    if (rpcReconnectTimeout) clearTimeout(rpcReconnectTimeout);
    rpcReconnectTimeout = setTimeout(connectDiscordRPC, 10000);
  };

  try {
    connectDiscordRPC._loginInFlight = true;
    Promise.resolve(rpc.login({ clientId: DISCORD_CLIENT_ID }))
      .catch(() => {
        rpcConnected = false;
        scheduleReconnect();
      })
      .finally(() => {
        connectDiscordRPC._loginInFlight = false;
      });
  } catch (err) {
    rpcConnected = false;
    connectDiscordRPC._loginInFlight = false;
    scheduleReconnect();
  }
}

function updateDiscordPresence(trackData) {
  if (app.isQuitting || !rpcConnected || !rpc || !rpc.setActivity || !trackData || !trackData.title) return;

  const activity = {
    type: 2,
    details: trackData.title,
    state: `by ${trackData.artist || 'Unknown Artist'}`,
    largeImageKey: trackData.artworkUrl || 'https://i.imgur.com/6bFDfYA.png',
    largeImageText: trackData.title,
    instance: false,
    buttons: [{ label: 'Listen on SoundCloud', url: 'https://soundcloud.com' }]
  };

  if (trackData.isPlaying && trackData.calculatedStart && trackData.calculatedEnd) {
    activity.startTimestamp = trackData.calculatedStart;
    activity.endTimestamp = trackData.calculatedEnd;
  }

  try {
    Promise.resolve(rpc.setActivity(activity)).catch(() => {});
  } catch (err) {
    // ignore transport issues when Discord is unavailable
  }
}

rpc.on('ready', () => {
  rpcConnected = true;
  if (currentTrack && currentTrack.title) updateDiscordPresence(currentTrack);
});

rpc.on('error', () => {
  rpcConnected = false;
  if (!app.isQuitting) {
    if (rpcReconnectTimeout) clearTimeout(rpcReconnectTimeout);
    rpcReconnectTimeout = setTimeout(connectDiscordRPC, 10000);
  }
});

rpc.on('disconnected', () => {
  rpcConnected = false;
  if (!app.isQuitting) {
    if (rpcReconnectTimeout) clearTimeout(rpcReconnectTimeout);
    rpcReconnectTimeout = setTimeout(connectDiscordRPC, 10000);
  }
});

function getGeniusWindowHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Genius Lyrics</title>
  <style>
    :root {
      color-scheme: dark;
    }
    * {
      box-sizing: border-box;
      font-family: "Segoe UI", "Helvetica Neue", sans-serif;
    }
    body {
      margin: 0;
      background: rgba(18, 18, 18, 0.95);
      color: #f2f2f2;
      border: 1px solid #2b2b2b;
      border-radius: 14px;
      overflow: hidden;
    }
    @keyframes slideIn {
      from {
        transform: translateX(-100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
    @keyframes slideOut {
      from {
        transform: translateX(0);
        opacity: 1;
      }
      to {
        transform: translateX(-100%);
        opacity: 0;
      }
    }
    .wrap {
      height: 100vh;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px;
      transform: translateX(-100%);
      opacity: 0;
      animation: slideIn 0.3s ease-out forwards;
    }
    .wrap.slide-out {
      animation: slideOut 0.22s ease-in forwards;
    }
    h2 {
      margin: 0;
      font-size: 16px;
      color: #ffffff;
    }
    label {
      font-size: 12px;
      color: #cccccc;
    }
    input {
      background: #101010;
      border: 1px solid #303030;
      color: #f5f5f5;
      border-radius: 8px;
      padding: 9px 10px;
      outline: none;
    }
    input:focus {
      border-color: #ff5500;
      box-shadow: 0 0 0 2px rgba(255, 85, 0, 0.25);
    }
    button {
      border: 0;
      border-radius: 8px;
      padding: 9px 10px;
      background: #ff5500;
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }
    #result {
      flex: 1;
      background: #0f0f0f;
      border: 1px solid #2c2c2c;
      border-radius: 8px;
      padding: 10px;
      white-space: pre-wrap;
      overflow-y: auto;
      color: #dedede;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h2>Genius Lyrics</h2>
    <label for="artist">Artist Name</label>
    <input id="artist" type="text" placeholder="Artist Name" autocomplete="off" />
    <label for="song">Song Name</label>
    <input id="song" type="text" placeholder="Song Name" autocomplete="off" />
    <button id="search" type="button">Search</button>
    <div id="result">Enter artist and song, then search.</div>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const artistInput = document.getElementById('artist');
    const songInput = document.getElementById('song');
    const searchButton = document.getElementById('search');
    const result = document.getElementById('result');
    const wrap = document.querySelector('.wrap');

    ipcRenderer.on('genius:animate-out', () => {
      if (!wrap || wrap.classList.contains('slide-out')) return;
      wrap.classList.add('slide-out');
      wrap.addEventListener('animationend', () => {
        ipcRenderer.invoke('genius:close-now');
      }, { once: true });
    });

    searchButton.addEventListener('click', async () => {
      const artist = artistInput.value.trim();
      const song = songInput.value.trim();

      if (!artist || !song) {
        result.textContent = 'Please enter both Artist Name and Song Name.';
        return;
      }

      result.textContent = 'Searching lyrics...';

      try {
        const response = await ipcRenderer.invoke('genius:search', { artist, song });
        if (response && response.ok && response.lyrics) {
          result.textContent = response.lyrics;
        } else {
          result.textContent = 'Lyrics not found';
        }
      } catch (error) {
        result.textContent = 'Lyrics not found';
      }
    });
  </script>
</body>
</html>`;
}

function createGeniusWindow() {
  if (!win || win.isDestroyed()) return;

  const mainBounds = win.getBounds();
  const width = 320;
  const height = 650;
  const x = Math.round(mainBounds.x);
  const y = Math.round(mainBounds.y + 40);

  geniusWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    parent: win,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  geniusWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(getGeniusWindowHtml())}`);
  geniusWindow.once('ready-to-show', () => {
    if (geniusWindow && !geniusWindow.isDestroyed()) {
      geniusWindow.show();
      geniusWindow.focus();
    }
  });

  geniusWindow.on('closed', () => {
    geniusWindow = null;
  });
}

function toggleGeniusWindow() {
  if (!geniusWindow || geniusWindow.isDestroyed()) {
    createGeniusWindow();
    return;
  }

  geniusWindow.webContents.send('genius:animate-out');
}

function startTrackMonitoring() {
  if (trackMonitoringInterval) {
    clearInterval(trackMonitoringInterval);
  }

  trackMonitoringInterval = setInterval(async () => {
    try {
      const scraped = await view.webContents.executeJavaScript(`
        (() => {
          function parseTime(str) {
            if (!str) return 0;
            const parts = str.trim().split(':').map(Number);
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            if (parts.length === 2) return parts[0] * 60 + parts[1];
            return 0;
          }

          let title = '';
          let artist = '';
          let artworkUrl = 'https://i.imgur.com/6bFDfYA.png';
          let isPlaying = false;
          let timePassed = 0;
          let duration = 0;

          const playBtn = document.querySelector('.playControl');
          const titleEl = document.querySelector('.playbackSoundBadge__titleLink');
          const artistEl = document.querySelector('.playbackSoundBadge__lightLink');

          if (playBtn) isPlaying = playBtn.classList.contains('playing');
          if (titleEl) title = (titleEl.getAttribute('title') || titleEl.innerText || '').trim();
          if (artistEl) artist = (artistEl.getAttribute('title') || artistEl.innerText || '').trim();

          try {
            const timeEl = document.querySelector('.playbackTimeline__timePassed > span[aria-hidden="true"]');
            const durEl = document.querySelector('.playbackTimeline__duration > span[aria-hidden="true"]');
            if (timeEl) timePassed = parseTime(timeEl.innerText);
            if (durEl) duration = parseTime(durEl.innerText);
          } catch (e) {}

          try {
            if (
              'mediaSession' in navigator &&
              navigator.mediaSession.metadata &&
              navigator.mediaSession.metadata.artwork &&
              navigator.mediaSession.metadata.artwork.length > 0
            ) {
              const arts = navigator.mediaSession.metadata.artwork;
              artworkUrl = arts[arts.length - 1].src;
            } else {
              const metaImg = document.querySelector('meta[property="og:image"]');
              if (metaImg && metaImg.content) artworkUrl = metaImg.content;
            }
            artworkUrl = artworkUrl.replace(/-t[0-9]+x[0-9]+\./, '-t500x500.');
          } catch (e) {}

          return { title, artist, artworkUrl, playing: isPlaying, timePassed, duration };
        })();
      `);

      if (!scraped || !scraped.title) return;

      let calculatedStart = null;
      let calculatedEnd = null;

      if (scraped.playing && scraped.duration > 0) {
        const now = Date.now();
        calculatedStart = now - scraped.timePassed * 1000;
        calculatedEnd = calculatedStart + scraped.duration * 1000;
      }

      const trackData = {
        title: scraped.title,
        artist: scraped.artist || 'Unknown Artist',
        artworkUrl: scraped.artworkUrl,
        isPlaying: scraped.playing,
        calculatedStart,
        calculatedEnd
      };

      const trackChanged =
        currentTrack.title !== trackData.title ||
        currentTrack.artist !== trackData.artist ||
        currentTrack.isPlaying !== trackData.isPlaying;

      if (trackChanged) {
        if (trackData.isPlaying && trackData.title !== currentTrackName) {
          currentTrackName = trackData.title;
        }

        currentTrack = trackData;
        updateDiscordPresence(trackData);
      }
    } catch (err) {
      if (err.message && !err.message.includes('Object has been destroyed')) {
        // silently ignore renderer errors during navigation
      }
    }
  }, 2000);
}

function injectVolumeBoostHook() {
  const multiplier = store.get('volumeBoost') || 1.0;

  view.webContents
    .executeJavaScript(`
      (function() {
        if (window._audioEngineHijacked) return;
        window._audioEngineHijacked = true;
        window._globalGainNodes = [];
        window._currentVolumeMultiplier = ${multiplier};

        const OrigCtx = window.AudioContext || window.webkitAudioContext;
        const originalCreateGain = OrigCtx.prototype.createGain;

        OrigCtx.prototype.createGain = function() {
          const gainNode = originalCreateGain.call(this);
          const ctx = this;

          const compressor = ctx.createDynamicsCompressor();
          compressor.threshold.value = -2.0;
          compressor.knee.value = 0.0;
          compressor.ratio.value = 20.0;
          compressor.attack.value = 0.005;
          compressor.release.value = 0.05;

          const originalConnect = gainNode.connect.bind(gainNode);
          gainNode.connect = function(destination, outputIndex, inputIndex) {
            if (destination === ctx.destination) {
              originalConnect(compressor);
              compressor.connect(ctx.destination);
              return destination;
            }
            return originalConnect(destination, outputIndex, inputIndex);
          };

          gainNode.gain.value = window._currentVolumeMultiplier;
          window._globalGainNodes.push(gainNode);
          return gainNode;
        };
      })();
    `)
    .catch(() => {});
}

function setVolumeBoost(multiplier) {
  store.set('volumeBoost', multiplier);

  if (view && !view.webContents.isDestroyed()) {
    view.webContents
      .executeJavaScript(`
        window._currentVolumeMultiplier = ${multiplier};
        window._globalGainNodes.forEach(function(node) {
          if (node && node.gain) node.gain.value = ${multiplier};
        });
      `)
      .catch(() => {});
  }

  createTray(win);
}

const MINI_PLAYER_CSS = `
  .l-sidebar,
  .l-footer,
  .header__navMenu,
  .webFooter,
  .listenEngagement,
  .soundBadgeList,
  [class*="rightSidebar"],
  [class*="commentsList"] {
    display: none !important;
  }
  .playControls {
    margin: 0 auto;
    justify-content: center;
  }
  .playbackSoundBadge {
    max-width: 100%;
  }
`;

function applyMiniMode() {
  if (!win) return;
  try {
    if (!store.get('miniMode')) {
      const bounds = win.getBounds();
      originalWindowBounds = { width: bounds.width, height: bounds.height };
    }
    win.setBounds({ width: 400, height: 120 });
    win.setAlwaysOnTop(true);
    view.webContents.insertCSS(MINI_PLAYER_CSS);
  } catch (err) {}
}

function removeMiniMode() {
  if (!win) return;
  try {
    win.setBounds({ width: originalWindowBounds.width, height: originalWindowBounds.height });
    win.setAlwaysOnTop(false);
    view.webContents.insertCSS('::-webkit-scrollbar { display: none; }');
  } catch (err) {}
}

function toggleMiniMode() {
  const newMiniMode = !store.get('miniMode');
  store.set('miniMode', newMiniMode);
  newMiniMode ? applyMiniMode() : removeMiniMode();
  createTray(win);
}

async function toggleAutoLaunch() {
  try {
    const isEnabled = await autoLauncher.isEnabled();
    if (isEnabled) {
      await autoLauncher.disable();
      store.set('autoLaunch', false);
    } else {
      await autoLauncher.enable();
      store.set('autoLaunch', true);
    }
    createTray(win);
  } catch (err) {}
}

function createTray(window) {
  if (!tray) {
    const iconPath = path.join(__dirname, './assets/icon.ico');
    tray = new Tray(iconPath);
    tray.setToolTip('SoundCloud Electron');
    tray.on('double-click', () => {
      window.isVisible() ? window.hide() : window.show();
    });
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => { window.show(); } },
    { label: 'Hide App', click: () => { window.hide(); } },
    { type: 'separator' },
    {
      label: 'Mini Mode',
      type: 'checkbox',
      checked: store.get('miniMode'),
      click: toggleMiniMode
    },
    {
      label: 'Volume Boost',
      submenu: [100, 125, 150, 175, 200, 225, 250, 275, 300].map((pct) => ({
        label: pct === 100 ? '100% (Normal)' : `${pct}%`,
        type: 'radio',
        checked: Math.round(store.get('volumeBoost') * 100) === pct,
        click: () => setVolumeBoost(pct / 100)
      }))
    },
    {
      label: 'Auto-Launch on Startup',
      type: 'checkbox',
      checked: store.get('autoLaunch'),
      click: toggleAutoLaunch
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function slugifyInput(value, options = {}) {
  const { forceLowercase = true } = options;
  const cleaned = (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

  return forceLowercase ? cleaned.toLowerCase() : cleaned;
}

function extractLyricsFromHtml(html) {
  const $ = cheerio.load(html);
  const blockTexts = [];

  $('[data-lyrics-container="true"]').each((_, el) => {
    const blockHtml = $(el)
      .html()
      .replace(/<br\s*\/?\s*>/gi, '\n');

    const text = cheerio
      .load(`<div>${blockHtml}</div>`)
      .text()
      .replace(/^\s*\[[^\]]+\]\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (text) {
      blockTexts.push(text);
    }
  });

  if (blockTexts.length > 0) {
    return blockTexts.join('\n\n').trim();
  }

  const fallback = $('.lyrics').first().text().replace(/\n{3,}/g, '\n\n').trim();
  return fallback || null;
}

ipcMain.handle('genius:search', async (_event, payload) => {
  const artist = (payload && payload.artist ? payload.artist : '').trim();
  const song = (payload && payload.song ? payload.song : '').trim();

  if (!artist || !song) {
    return {
      ok: false,
      message: 'Please enter both Artist Name and Song Name.'
    };
  }

  const artistSlug = slugifyInput(artist, { forceLowercase: false });
  const songSlug = slugifyInput(song, { forceLowercase: true });
  const url = `https://genius.com/${artistSlug}-${songSlug}-lyrics`;

  try {
    const response = await axios.get(url, {
      timeout: 12000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
      }
    });

    const lyrics = extractLyricsFromHtml(response.data);

    if (!lyrics) {
      return {
        ok: false,
        url,
        message: 'Lyrics not found'
      };
    }

    return {
      ok: true,
      url,
      lyrics
    };
  } catch (error) {
    return {
      ok: false,
      url,
      message: 'Lyrics not found'
    };
  }
});

app.whenReady().then(async () => {
  const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
  blocker.enableBlockingInSession(session.defaultSession);

  createWindow();
  registerGlobalShortcuts();
  connectDiscordRPC();

  try {
    const storedAutoLaunch = store.get('autoLaunch');
    const isEnabled = await autoLauncher.isEnabled();
    if (storedAutoLaunch && !isEnabled) {
      await autoLauncher.enable();
    } else if (!storedAutoLaunch && isEnabled) {
      await autoLauncher.disable();
    }
  } catch (err) {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && app.isQuitting) {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

function cleanup() {
  if (trackMonitoringInterval) {
    clearInterval(trackMonitoringInterval);
    trackMonitoringInterval = null;
  }

  if (rpcReconnectTimeout) {
    try {
      clearTimeout(rpcReconnectTimeout);
    } catch (err) {}
    rpcReconnectTimeout = null;
  }

  rpcConnected = false;
  connectDiscordRPC._loginInFlight = false;

  if (rpc) {
    Promise.resolve(rpc.clearActivity && rpc.clearActivity())
      .catch(() => {})
      .finally(() => {
        try {
          if (rpc.destroy) rpc.destroy();
        } catch (err) {}
      });
  }

  if (geniusWindow && !geniusWindow.isDestroyed()) {
    geniusWindow.close();
    geniusWindow = null;
  }

  globalShortcut.unregisterAll();
}
