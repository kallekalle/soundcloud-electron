// preload-view.js — injected into the SoundCloud BrowserView
// Observes SoundCloud's play/shuffle/repeat buttons and forwards
// state to the main process so the thumbar always stays in sync.

const { ipcRenderer } = require('electron');

function getState() {
  const playBtn = document.querySelector('.playControl');
  const shuffleBtn = document.querySelector('.shuffleControl');
  const repeatBtn = document.querySelector('.repeatControl');
  return {
    isPlaying: playBtn ? playBtn.classList.contains('playing') : false,
    isShuffle: shuffleBtn ? shuffleBtn.classList.contains('m-active') : false,
    isRepeat: repeatBtn ? repeatBtn.classList.contains('m-active') : false
  };
}

function sendState() {
  ipcRenderer.send('thumbar:playback-state', getState());
}

function attachObservers() {
  const playBtn = document.querySelector('.playControl');
  const shuffleBtn = document.querySelector('.shuffleControl');
  const repeatBtn = document.querySelector('.repeatControl');

  // Need at least the play button before we consider the bar ready
  if (!playBtn) return false;

  sendState();

  const observer = new MutationObserver(sendState);
  const opts = { attributes: true, attributeFilter: ['class'] };

  observer.observe(playBtn, opts);
  if (shuffleBtn) observer.observe(shuffleBtn, opts);
  if (repeatBtn) observer.observe(repeatBtn, opts);

  return true;
}

// SoundCloud is a SPA — the play bar may not exist at first load.
// Poll until the bar appears, then hand off to MutationObserver.
function waitForPlayerBar() {
  if (attachObservers()) return;
  const id = setInterval(() => { if (attachObservers()) clearInterval(id); }, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', waitForPlayerBar);
} else {
  waitForPlayerBar();
}
