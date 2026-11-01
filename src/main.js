import { Game } from './Game.js';

const params = new URLSearchParams(location.search);
const game = new Game(document.getElementById('game'), params);
window.game = game;
addEventListener('error', e => { const b = document.getElementById('err'); if (b) b.textContent += `${e.message} (${e.filename?.split('/').pop()}:${e.lineno})\n`; });
addEventListener('unhandledrejection', e => { const b = document.getElementById('err'); if (b) b.textContent += String(e.reason?.stack ?? e.reason) + '\n'; });
await game.init();
game.start();
if (params.has('probe')) {
  setTimeout(() => {
    const c = game.player, B = c.bones, V = o => o.getWorldPosition(new (c.pos.constructor)()).toArray().map(v => +v.toFixed(2));
    const sc = o => o.getWorldScale(new (c.pos.constructor)()).toArray().map(v => +v.toFixed(3));
    const q = document.getElementById('err');
    q.textContent = JSON.stringify({ handR: V(B.hand_r), handScale: sc(B.hand_r), holderScale: sc(c.holder), holderPos: V(c.holder), mid: V(B.middle_01_r), model: sc(c.model), muzzle: V(c.weapons.slot.model.userData.muzzle), holderLocal: c.holder.position.toArray(), char: c.pos.toArray() });
  }, 3000);
}
