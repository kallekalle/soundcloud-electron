let view;

const { app, BrowserWindow, BrowserView, Menu, Tray, session, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const { ElectronBlocker } = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');
const Store = require('electron-store');
const AutoLaunch = require('auto-launch');
const DiscordRPC = require('discord-rpc');

const DISCORD_CLIENT_ID = '1477971683708108854';

const store = new Store({
  defaults: {
    miniMode: false,
    autoLaunch: false,
    discordRpcEnabled: true,
    volumeBoost: 1.0
  }
});

const autoLauncher = new AutoLaunch({
  name: 'SoundCloud Electron',
  isHidden: true
});

const rpc = new DiscordRPC.Client({ transport: 'ipc' });
let rpcConnected = false;
let rpcReconnectTimeout = null;

let tray = null;
let win = null;
let trackMonitoringInterval = null;
let currentTrack = { title: null, artist: null, artwork: null, isPlaying: false };
let originalWindowBounds = { width: 1200, height: 800 };
let trackStartTime = null;
let currentTrackName = '';

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
    ...(process.platform !== 'darwin' ? {
      titleBarOverlay: {
        color: '#121212',
        symbolColor: '#CCCCCC'
      }
    } : {}),
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
      contextIsolation: true,
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
  });

  ipcMain.handle('nav:back', () => {
    if (view.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack();
    }
  });
  ipcMain.handle('nav:forward', () => {
    if (view.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward();
    }
  });
  ipcMain.handle('nav:reload', () => {
    view.webContents.reload();
  });

  view.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      view.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  view.webContents.on('did-finish-load', () => {
    view.webContents.insertCSS(`::-webkit-scrollbar { display: none; }`);

    view.webContents.executeJavaScript(`
    const removeElements = () => {
      const selectors = [
        '.header__upsellWrapper.left',
        '.l-product-banners.l-inner-fullwidth',
        'div.trackMonetizationSidebarUpsell.sc-background-light.sc-pt-5x.sc-pb-2x.sc-px-2x.sc-mb-3x.sc-mx-1x',
        'div.quotaMeterWrapper',
        'article.sidebarModule.g-all-transitions-200-linear.mobileApps'
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove());
      });

      document.querySelectorAll('div.sidebarModule').forEach(el => {
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

function registerGlobalShortcuts() {
  try {
    globalShortcut.register('MediaPlayPause', () => {
      try {
        view.webContents.executeJavaScript(`
          document.querySelector('.playControls__play')?.click();
        `).catch(() => { });
      } catch (err) { }
    });

    globalShortcut.register('MediaNextTrack', () => {
      try {
        view.webContents.executeJavaScript(`
          document.querySelector('.skipControls__next')?.click();
        `).catch(() => { });
      } catch (err) { }
    });

    globalShortcut.register('MediaPreviousTrack', () => {
      try {
        view.webContents.executeJavaScript(`
          document.querySelector('.skipControls__previous')?.click();
        `).catch(() => { });
      } catch (err) { }
    });
  } catch (err) { }
}

function connectDiscordRPC() {
  if (!store.get('discordRpcEnabled') || DISCORD_CLIENT_ID === 'YOUR_CLIENT_ID_HERE') return;
  if (rpcConnected) return;

  try {
    rpc.login({ clientId: DISCORD_CLIENT_ID }).catch(err => {
      if (rpcReconnectTimeout) clearTimeout(rpcReconnectTimeout);
      rpcReconnectTimeout = setTimeout(connectDiscordRPC, 10000);
    });
  } catch (err) { }
}

rpc.on('ready', () => {
  rpcConnected = true;
  if (currentTrack.title) updateDiscordPresence(currentTrack);
});

rpc.on('error', () => {
  rpcConnected = false;
  if (rpcReconnectTimeout) clearTimeout(rpcReconnectTimeout);
  rpcReconnectTimeout = setTimeout(connectDiscordRPC, 10000);
});

function updateDiscordPresence(trackData) {
  if (!rpcConnected || !store.get('discordRpcEnabled')) return;
  if (!trackData.title) return;

  try {
    const activity = {
      type: 2,
      details: trackData.title,
      state: 'by ' + (trackData.artist || 'Unknown Artist'),
      largeImageKey: trackData.artworkUrl || 'https://i.imgur.com/6bFDfYA.png',
      largeImageText: trackData.title,
      instance: false,
      buttons: [
        { label: 'Listen on SoundCloud', url: 'https://soundcloud.com' }
      ]
    };

    if (trackData.isPlaying && trackData.calculatedStart && trackData.calculatedEnd) {
      activity.startTimestamp = trackData.calculatedStart;
      activity.endTimestamp = trackData.calculatedEnd;
    }

    rpc.setActivity(activity).catch(() => { });
  } catch (err) { }
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

          let title = '', artist = '', artworkUrl = 'https://i.imgur.com/6bFDfYA.png', isPlaying = false;
          let timePassed = 0, duration = 0;

          const playBtn  = document.querySelector('.playControl');
          const titleEl  = document.querySelector('.playbackSoundBadge__titleLink');
          const artistEl = document.querySelector('.playbackSoundBadge__lightLink');
          if (playBtn)  isPlaying = playBtn.classList.contains('playing');
          if (titleEl)  title     = (titleEl.getAttribute('title')  || titleEl.innerText  || '').trim();
          if (artistEl) artist    = (artistEl.getAttribute('title') || artistEl.innerText || '').trim();

          try {
            const timeEl = document.querySelector('.playbackTimeline__timePassed > span[aria-hidden="true"]');
            const durEl  = document.querySelector('.playbackTimeline__duration > span[aria-hidden="true"]');
            if (timeEl) timePassed = parseTime(timeEl.innerText);
            if (durEl)  duration   = parseTime(durEl.innerText);
          } catch(e) {}

          try {
            if ('mediaSession' in navigator &&
                navigator.mediaSession.metadata &&
                navigator.mediaSession.metadata.artwork &&
                navigator.mediaSession.metadata.artwork.length > 0) {
              const arts = navigator.mediaSession.metadata.artwork;
              artworkUrl = arts[arts.length - 1].src;
            } else {
              const metaImg = document.querySelector('meta[property="og:image"]');
              if (metaImg && metaImg.content) artworkUrl = metaImg.content;
            }
            artworkUrl = artworkUrl.replace(/-t[0-9]+x[0-9]+\./, '-t500x500.');
          } catch(e) {}

          return { title, artist, artworkUrl, playing: isPlaying, timePassed, duration };
        })()
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
          trackStartTime = new Date(calculatedStart || Date.now());
        } else if (!trackData.isPlaying) {
          trackStartTime = null;
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

  view.webContents.executeJavaScript(`
    (function() {
      if (window._audioEngineHijacked) return;
      window._audioEngineHijacked = true;
      window._globalGainNodes = [];
      window._currentVolumeMultiplier = ${multiplier};

      const OrigCtx = window.AudioContext || window.webkitAudioContext;
      const originalCreateGain = OrigCtx.prototype.createGain;

      OrigCtx.prototype.createGain = function() {
        const gainNode = originalCreateGain.call(this);
        const ctx      = this;

        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -2.0;
        compressor.knee.value      =  0.0;
        compressor.ratio.value     = 20.0;
        compressor.attack.value    =  0.005;
        compressor.release.value   =  0.050;

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
  `).catch(() => { });
}

function setVolumeBoost(multiplier) {
  store.set('volumeBoost', multiplier);

  view.webContents.executeJavaScript(`
    window._currentVolumeMultiplier = ${multiplier};
    window._globalGainNodes.forEach(function(node) {
      if (node && node.gain) node.gain.value = ${multiplier};
    });
  `).catch(() => { });

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
  } catch (err) { }
}

function removeMiniMode() {
  if (!win) return;
  try {
    win.setBounds({ width: originalWindowBounds.width, height: originalWindowBounds.height });
    win.setAlwaysOnTop(false);
    view.webContents.insertCSS(`::-webkit-scrollbar { display: none; }`);
  } catch (err) { }
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
  } catch (err) { }
}

function toggleDiscordRPC() {
  const newEnabled = !store.get('discordRpcEnabled');
  store.set('discordRpcEnabled', newEnabled);

  if (newEnabled) {
    connectDiscordRPC();
  } else if (rpcConnected) {
    try {
      rpc.clearActivity();
      rpcConnected = false;
    } catch (err) { }
  }

  createTray(win);
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
      label: 'Discord Rich Presence',
      type: 'checkbox',
      checked: store.get('discordRpcEnabled'),
      click: toggleDiscordRPC
    },
    {
      label: 'Volume Boost',
      submenu: [100, 125, 150, 175, 200, 225, 250, 275, 300].map(pct => ({
        label: pct === 100 ? '100% (Normal)' : pct + '%',
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

app.whenReady().then(async () => {
  const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
  blocker.enableBlockingInSession(session.defaultSession);

  createWindow();
  registerGlobalShortcuts();

  if (store.get('discordRpcEnabled')) {
    connectDiscordRPC();
  }

  try {
    const storedAutoLaunch = store.get('autoLaunch');
    const isEnabled = await autoLauncher.isEnabled();
    if (storedAutoLaunch && !isEnabled) {
      await autoLauncher.enable();
    } else if (!storedAutoLaunch && isEnabled) {
      await autoLauncher.disable();
    }
  } catch (err) { }
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
    clearTimeout(rpcReconnectTimeout);
    rpcReconnectTimeout = null;
  }

  if (rpcConnected) {
    try {
      rpc.destroy();
      rpcConnected = false;
    } catch (err) { }
  }

  globalShortcut.unregisterAll();
}