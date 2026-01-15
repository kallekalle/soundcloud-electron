let view;

const { app, BrowserWindow, BrowserView, Menu, Tray, ipcMain } = require('electron');
const path = require('path');


let tray = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
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

  // Remove title bar
  Menu.setApplicationMenu(null);
  win.loadFile('index.html')
  view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
    }
  });


  // Load the page
  win.setBrowserView(view);
  view.setBounds({ x: 0, y: 40, width: 1200, height: 760 }); // (with 30 margin at the top)
  view.setAutoResize({ width: true, height: true });
  view.webContents.loadURL('https://soundcloud.com');

  // Back- and refresh buttons
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


  // Enable DevTools (ctrl+shift+i)
  view.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      view.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  view.webContents.on('did-finish-load', () => {

    // Hide scroll bar
    view.webContents.insertCSS(`::-webkit-scrollbar { display: none; }`);

    // Remove "upgrade now" and "unlock artist tools" buttons
    view.webContents.executeJavaScript(`
    const removeElements = () => {
      const selectors = [
        '.header__upsellWrapper.left',
        '.l-product-banners.l-inner-fullwidth',
        'div.trackMonetizationSidebarUpsell.sc-background-light.sc-pt-5x.sc-pb-2x.sc-px-2x.sc-mb-3x.sc-mx-1x',
        'div.quotaMeterWrapper',
        'div.sidebarModule'
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove());
      });
    };

    removeElements();

    // Observe the DOM for changes and remove again if they show up
    const observer = new MutationObserver(() => {
      removeElements();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  `);
  });
  
  createTray(win);
}

function createTray(win) {
  const iconPath = path.join(__dirname, './assets/icon.ico');

  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => { win.show(); } },
    { label: 'Hide App', click: () => { win.hide(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } }
  ]);

  tray.setToolTip('SoundCloud Electron');
  tray.setContextMenu(contextMenu);

  // Double-click on tray icon to show/hide the window
  tray.on('double-click', () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
    }
  });
}



app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});