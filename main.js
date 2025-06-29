const { app, BrowserWindow, BrowserView, Menu } = require('electron');
const path = require('path');

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
  view.setBounds({ x: 0, y: 30, width: 1200, height: 770 }); // (with 30 margin at the top)
  view.setAutoResize({ width: true, height: true });
  view.webContents.loadURL('https://soundcloud.com');

  view.webContents.on('did-finish-load', () => {
    view.webContents.insertCSS(`::-webkit-scrollbar { display: none; }`); // Hide scroll bar
    // Remove "upgrade now" and "unlock artist tools" buttons
    view.webContents.executeJavaScript(`
    const removeElements = () => {
      const selectors = [
        '.header__upsellWrapper.left',
        '.l-product-banners.l-inner-fullwidth',
        '.sidebarModule'
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
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});