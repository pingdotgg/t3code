const { app, BrowserWindow } = require('electron');
const [maliciousUrl, previewA, previewB] = process.argv.slice(2);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(maliciousUrl);
  const maliciousFetch = await window.webContents.executeJavaScript(`fetch(${JSON.stringify(previewA + '/secret')}, { mode: 'no-cors' }).then(() => 'sent').catch(error => String(error))`);
  await new Promise(resolve => setTimeout(resolve, 150));
  await window.loadURL(previewA + '/storage');
  await window.webContents.executeJavaScript(`localStorage.setItem('phase05', 'sticky')`);
  await window.loadURL(previewB + '/storage');
  const otherPortValue = await window.webContents.executeJavaScript(`localStorage.getItem('phase05')`);
  await window.loadURL(previewA + '/storage');
  const originalPortValue = await window.webContents.executeJavaScript(`localStorage.getItem('phase05')`);
  process.stdout.write(`PHASE05_TUNNEL ${JSON.stringify({ maliciousFetch, otherPortValue, originalPortValue })}\n`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
