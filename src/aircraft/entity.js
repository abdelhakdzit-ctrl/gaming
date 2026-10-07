import * as THREE from 'three';

const FWD = new THREE.Vector3(0, 0, -1);
/** Anything that flies and can be targeted/damaged: player, wingman, enemies, assets. */
export class Entity {
  constructor(o) {
    this.id = o.id; this.name = o.name || o.id; this.callsign = o.callsign || o.id;
    this.side = o.side || 'hostile';           // true allegiance: hostile | friendly | neutral
    this.type = o.type || 'fighter'; this.role = o.role || 'fighter'; this.def = o.def || null;
    this.pos = o.pos || new THREE.Vector3(); this.quat = o.quat || new THREE.Quaternion(); this.vel = o.vel || new THREE.Vector3();
    this.speed = 0; this.maxHp = o.hp || 80; this.hp = this.maxHp; this.radius = o.radius || 10; this.alive = true;
    this.identified = !!o.identified;          // player-side knowledge of allegiance
    this.iffShown = o.iffShown || 'unknown';   // what the (possibly forged) IFF reports
    this.isPlayer = false; this.model = null; this.ai = null; this.flaresLeft = o.flares || 0; this.missilesLeft = o.missiles || 0;
    this.hasCannon = !!o.cannon; this.tags = new Set(); this.lastDamageBy = null; this.damageTaken = 0; this.despawned = false;
    this.crash = null; this.group = o.group || null;
  }
  forward(out = new THREE.Vector3()) { return out.copy(FWD).applyQuaternion(this.quat); }
  /** Apply HP loss, returns true when this hit destroyed the entity. */
  hurt(amount, source) {
    if (!this.alive) return false;
    this.hp -= amount; this.damageTaken += amount; this.lastDamageBy = source || this.lastDamageBy;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; return true; }
    return false;
  }
}
