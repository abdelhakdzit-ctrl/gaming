// Tiny pub/sub used for gunshots (AI hearing), damage, kills, HUD updates.
export class Events {
  constructor() { this.map = new Map(); }
  on(type, fn) { (this.map.get(type) ?? this.map.set(type, []).get(type)).push(fn); return () => this.off(type, fn); }
  off(type, fn) { const a = this.map.get(type); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
  emit(type, data) { this.map.get(type)?.slice().forEach(fn => fn(data)); }
}
