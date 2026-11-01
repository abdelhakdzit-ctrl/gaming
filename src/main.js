import { Game } from './Game.js';

const params = new URLSearchParams(location.search);
const game = new Game(document.getElementById('game'), params);
window.game = game;
addEventListener('error', e => { const b = document.getElementById('err'); if (b) b.textContent += `${e.message} (${e.filename?.split('/').pop()}:${e.lineno})\n`; });
addEventListener('unhandledrejection', e => { const b = document.getElementById('err'); if (b) b.textContent += String(e.reason?.stack ?? e.reason) + '\n'; });
await game.init();
game.start();
