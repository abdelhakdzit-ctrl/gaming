import * as THREE from 'three';

// Procedural weapon meshes in meters. Origin = pistol grip center, barrel along +Z, up = +Y.
// Markers: muzzle, foregrip (support hand), eject. Swap in a GLB later by returning a Group with the same markers.
const MAT = {
  metal: new THREE.MeshStandardMaterial({ color: 0x1d2024, metalness: 0.7, roughness: 0.38 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2a2d32, metalness: 0.4, roughness: 0.55 }),
  poly: new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.1, roughness: 0.8 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x6b4423, metalness: 0, roughness: 0.7 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x555b63, metalness: 0.85, roughness: 0.3 }),
};
const box = (g, m, w, h, d, x, y, z, rx = 0) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.rotation.x = rx; o.castShadow = true; g.add(o); return o; };
const cyl = (g, m, r, len, x, y, z, r2 = r) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, 12), m); o.rotation.x = Math.PI / 2; o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; };
const marker = (g, name, x, y, z) => { const o = new THREE.Object3D(); o.name = name; o.position.set(x, y, z); g.add(o); return o; };

const BUILDERS = {
  pistol() {
    const g = new THREE.Group();
    box(g, MAT.dark, 0.032, 0.05, 0.1, 0, -0.045, 0, -0.18);          // grip
    const slide = box(g, MAT.metal, 0.03, 0.036, 0.21, 0, 0.03, 0.07); slide.name = 'slide';
    box(g, MAT.dark, 0.026, 0.02, 0.15, 0, 0.0, 0.07);                  // frame
    box(g, MAT.dark, 0.006, 0.026, 0.03, 0, -0.012, 0.05);              // trigger guard
    box(g, MAT.steel, 0.01, 0.01, 0.008, 0, 0.052, 0.16);               // sights
    box(g, MAT.steel, 0.01, 0.01, 0.008, 0, 0.052, -0.02);
    const mag = box(g, MAT.steel, 0.026, 0.055, 0.04, 0, -0.1, -0.02); mag.name = 'mag';
    marker(g, 'muzzle', 0, 0.03, 0.175); marker(g, 'foregrip', 0.0, -0.06, 0.0); marker(g, 'eject', 0.02, 0.04, 0.05);
    return g;
  },
  rifle() {
    const g = new THREE.Group();
    box(g, MAT.poly, 0.034, 0.1, 0.045, 0, -0.06, -0.02, -0.25);              // pistol grip
    box(g, MAT.dark, 0.05, 0.1, 0.28, 0, 0.025, 0.1);                          // receiver
    box(g, MAT.dark, 0.04, 0.03, 0.2, 0, 0.1, 0.06);                           // carry handle / rail
    box(g, MAT.poly, 0.05, 0.09, 0.3, 0, 0.0, 0.43);                           // handguard
    cyl(g, MAT.metal, 0.009, 0.3, 0, 0.03, 0.72);                              // barrel
    cyl(g, MAT.metal, 0.014, 0.07, 0, 0.03, 0.88);                             // flash hider
    box(g, MAT.poly, 0.045, 0.1, 0.24, 0, -0.01, -0.28);                       // stock
    box(g, MAT.steel, 0.006, 0.03, 0.006, 0, 0.065, 0.82);                     // front sight
    const mag = box(g, MAT.steel, 0.034, 0.14, 0.06, 0, -0.1, 0.1, 0.12); mag.name = 'mag';
    marker(g, 'muzzle', 0, 0.03, 0.915); marker(g, 'foregrip', 0, -0.06, 0.42); marker(g, 'eject', 0.03, 0.05, 0.1);
    return g;
  },
  smg() {
    const g = new THREE.Group();
    box(g, MAT.poly, 0.032, 0.09, 0.04, 0, -0.055, -0.02, -0.2);
    box(g, MAT.dark, 0.048, 0.085, 0.3, 0, 0.025, 0.12);
    box(g, MAT.poly, 0.05, 0.07, 0.16, 0, -0.005, 0.34);                       // handguard
    cyl(g, MAT.metal, 0.009, 0.1, 0, 0.03, 0.47);
    box(g, MAT.steel, 0.012, 0.02, 0.2, 0, -0.01, -0.22);                      // wire stock
    const mag = box(g, MAT.steel, 0.028, 0.15, 0.04, 0, -0.12, 0.17, 0.25); mag.name = 'mag';
    box(g, MAT.steel, 0.006, 0.02, 0.006, 0, 0.075, 0.42);
    marker(g, 'muzzle', 0, 0.03, 0.52); marker(g, 'foregrip', 0, -0.055, 0.33); marker(g, 'eject', 0.03, 0.05, 0.12);
    return g;
  },
  shotgun() {
    const g = new THREE.Group();
    box(g, MAT.wood, 0.034, 0.1, 0.045, 0, -0.06, -0.02, -0.3);
    box(g, MAT.dark, 0.045, 0.085, 0.25, 0, 0.025, 0.1);
    cyl(g, MAT.metal, 0.015, 0.62, 0, 0.035, 0.52);                            // barrel
    cyl(g, MAT.metal, 0.012, 0.5, 0, -0.01, 0.46);                             // tube mag
    const pump = box(g, MAT.wood, 0.05, 0.05, 0.2, 0, -0.012, 0.4); pump.name = 'pump';
    box(g, MAT.wood, 0.05, 0.11, 0.3, 0, -0.01, -0.28, 0.05);
    box(g, MAT.steel, 0.006, 0.014, 0.006, 0, 0.058, 0.82);
    marker(g, 'muzzle', 0, 0.035, 0.84); marker(g, 'foregrip', 0, -0.05, 0.4); marker(g, 'eject', 0.03, 0.05, 0.1);
    return g;
  },
  sniper() {
    const g = new THREE.Group();
    box(g, MAT.wood, 0.034, 0.1, 0.045, 0, -0.06, -0.03, -0.3);
    box(g, MAT.dark, 0.04, 0.07, 0.28, 0, 0.025, 0.12);
    cyl(g, MAT.metal, 0.011, 0.7, 0, 0.03, 0.65);
    box(g, MAT.wood, 0.045, 0.08, 0.55, 0, -0.0, 0.55);                        // fore stock
    box(g, MAT.wood, 0.05, 0.13, 0.35, 0, -0.02, -0.3, 0.1);
    const bolt = box(g, MAT.steel, 0.07, 0.014, 0.014, 0.035, 0.05, 0.02); bolt.name = 'bolt';
    cyl(g, MAT.dark, 0.022, 0.26, 0, 0.1, 0.14);                               // scope
    marker(g, 'muzzle', 0, 0.03, 1.0); marker(g, 'foregrip', 0, -0.05, 0.5); marker(g, 'eject', 0.04, 0.05, 0.05);
    return g;
  },
};

export function buildWeaponModel(kind) {
  const g = BUILDERS[kind]();
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.userData = { muzzle: g.getObjectByName('muzzle'), foregrip: g.getObjectByName('foregrip'), eject: g.getObjectByName('eject'), mag: g.getObjectByName('mag') };
  return g;
}
