import dialogue from '../../data/dialogue.json';

// Every mission is its own file in data/missions/. Files may carry their own radio `lines`, merged into the global table.
const files = import.meta.glob('../../data/missions/m*.json', { eager: true, import: 'default' });
export const MISSIONS = Object.values(files).sort((a, b) => a.number - b.number);
for (const m of MISSIONS) Object.assign(dialogue.lines, m.lines || {});
export const FINAL_MISSION = MISSIONS[MISSIONS.length - 1];
export const missionById = (id) => MISSIONS.find((m) => m.id === id);
