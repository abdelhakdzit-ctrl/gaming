"""Procedural UE5-mannequin walk cycle (in place, 30 fps, 36-frame loop).
Run: python make_walk.py <input.fbx> <outdir>   (needs `bpy`, Python 3.11)"""
import bpy, sys, math, os
from mathutils import Matrix, Vector, Euler

SRC, OUT = sys.argv[1], sys.argv[2]
FPS, N = 30, 36
S = 105.0           # stride length per foot (cm)
STANCE = 0.6
LIFT = 8.0
PELV_DROP = 7.0
D = math.radians

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=SRC)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='POSE')
pb = arm.pose.bones
rest = {b.name: b.matrix_local.copy() for b in arm.data.bones}
M3 = {k: v.to_3x3() for k, v in rest.items()}
head = {k: v.translation.copy() for k, v in rest.items()}
for p in pb:
    p.rotation_mode = 'QUATERNION'

def smooth(t): t = max(0., min(1., t)); return t*t*(3-2*t)
def keyed(p, keys):
    """periodic smoothstep interpolation through (phase, value) keys"""
    p %= 1.0
    ks = keys + [(keys[0][0] + 1, keys[0][1])]
    if p < ks[0][0]: p += 1
    for (a, va), (b, vb) in zip(ks, ks[1:]):
        if a <= p <= b:
            return va + (vb - va) * smooth((p - a) / (b - a))
    return ks[0][1]
def sn(p, ph=0., k=1): return math.sin(2*math.pi*k*(p - ph))

def setrot(name, eul):
    """eul: armature-space euler delta (x pitch, y roll about fwd axis, z yaw)"""
    R = Euler(eul, 'XYZ').to_matrix()
    q = (M3[name].inverted() @ R @ M3[name]).to_quaternion()
    pb[name].rotation_quaternion = q

L1 = (head['calf_l'] - head['thigh_l']); L2 = (head['foot_l'] - head['calf_l'])
l1, l2 = L1.length, L2.length
ang = lambda v: math.atan2(v.z, v.y)
t0, c0 = ang(L1), ang(L2)
ballrel = head['ball_l'] - head['foot_l']
def rot2(v, th):
    return Vector((0, v.y*math.cos(th) - v.z*math.sin(th), v.y*math.sin(th) + v.z*math.cos(th)))

def foot_state(p):
    """returns (forward pos f, lift z, pitch th)  for foot phase p"""
    p %= 1
    if p < STANCE:
        f = S*STANCE/2 - S*p
        z = 0.
    else:
        u = (p - STANCE)/(1-STANCE)
        f = -S*STANCE/2 + S*STANCE*smooth(u)
        z = LIFT*math.sin(math.pi*min(1, u**0.8))
    th = keyed(p, [(0, D(-16)), (0.10, 0), (0.38, 0), (0.60, D(32)), (0.72, D(14)), (0.90, D(-6)), (0.97, D(-16))])
    return f, z, th

def pose_frame(fr):
    p = fr / N
    for pbn in pb: 
        pbn.rotation_quaternion = (1,0,0,0); pbn.location = (0,0,0)
    # ---- pelvis
    sway = 2.6*sn(p, 0.05)
    bob = 1.8*-math.cos(4*math.pi*(p-0.05))
    fwd = 0.8*math.cos(4*math.pi*(p-0.05))
    pel = Vector((sway, -fwd, -PELV_DROP + bob))
    pb['pelvis'].location = M3['pelvis'].inverted() @ pel
    pyaw = D(6)*sn(p, 0.0)
    proll = D(3.0)*sn(p, 0.30+0.25)    # drops on swing side
    ppitch = D(2.5) + D(0.8)*math.cos(4*math.pi*(p-0.05))
    setrot('pelvis', (ppitch, proll, pyaw))
    # ---- legs (planar IK, feet planted)
    for side, ph in (('l', 0.0), ('r', 0.5)):
        f, z, th = foot_state(p + ph)
        thigh_h = head['thigh_'+side] + pel
        ankle0 = head['foot_'+side]
        # pivot compensation so heel/ball stays on floor
        if th >= 0:
            piv = head['ball_'+side]
        else:
            piv = ankle0 + Vector((0, 8.0, -ankle0.z))
        a = piv + rot2(ankle0 - piv, th)
        tgt = Vector((ankle0.x, ankle0.y - f + (a.y - ankle0.y), a.z + z))
        hip = Vector((0, thigh_h.y, thigh_h.z))
        v = Vector((0, tgt.y - hip.y, tgt.z - hip.z))
        d = min(v.length, (l1 + l2)*0.9995)
        beta = ang(v)
        gam = math.acos((l1*l1 + l2*l2 - d*d)/(2*l1*l2))
        dl = math.acos((l1*l1 + d*d - l2*l2)/(2*l1*d))
        at = beta - dl; ac = at + (math.pi - gam)
        a1, a2 = at - t0, ac - c0
        setrot('thigh_'+side, (a1, 0, 0))
        setrot('calf_'+side, (a2 - a1, 0, 0))
        setrot('foot_'+side, (th - a2, 0, 0))
    # ---- spine: counter-rotation with progressive lag (overlap)
    for i, nm in enumerate(('spine_01', 'spine_02', 'spine_03')):
        lag = 0.035*(i+1)
        yaw = D(5.5)*sn(p, lag)
        roll = -D(2.2)*sn(p, 0.55+lag)
        pitch = D(1.2)*math.cos(4*math.pi*(p-0.05-lag)) + (D(0.7)*sn(p, 0.1) if i == 2 else 0)
        breath = D(0.5)*sn(p, 0.1+0.1*i)
        setrot(nm, (pitch + breath + D(0.5), roll, yaw))
    # clavicles lead arms, shoulders rock
    for side in ('l', 'r'):
        # left arm is back when left leg forward (phase 0)
        arm_ph = 0.0 if side == 'l' else 0.5
        sw = math.cos(2*math.pi*(p - arm_ph - 0.04))
        setrot('clavicle_'+side, (D(1.5)*sw, D(1.2)*sw*(1 if side=='l' else -1), D(2.2)*sw*(1 if side=='l' else -1)))
        sw2 = math.cos(2*math.pi*(p - arm_ph - 0.06))
        up = D(11)*sw2 + D(2)
        setrot('upperarm_'+side, (up, D(0), D(0)))
        # elbow flexes more when forearm swings forward, drags behind
        sw3 = math.cos(2*math.pi*(p - arm_ph - 0.14))
        elbow = -(D(5) + D(6)*(1 - sw3))
        setrot('lowerarm_'+side, (elbow, 0, 0))
        sw4 = math.cos(2*math.pi*(p - arm_ph - 0.24))
        wrist = D(10)*sw4
        setrot('hand_'+side, (wrist, D(4)*sw4*(1 if side=='l' else -1), D(3)*sw4))
        # fingers: relaxed curl that lags the hand (staggered per joint & finger)
        for fi, fn in enumerate(('index', 'middle', 'ring', 'pinky')):
            base = D(3 + 2*fi)
            for j in (1, 2, 3):
                lagp = 0.30 + 0.025*fi + 0.04*j
                c = math.cos(2*math.pi*(p - arm_ph - lagp))
                curl = base*(0.55 + 0.25*j) + D(2)*c*j*0.6
                # curl direction: fingers hang down, curling toward the palm (forward = -pitch)
                setrot(f'{fn}_0{j}_{side}', (-curl, 0, 0))
        for j in (1, 2, 3):
            c = math.cos(2*math.pi*(p - arm_ph - 0.3 - 0.04*j))
            setrot(f'thumb_0{j}_{side}', (-(D(3) + D(2)*c)*j*0.5, 0, 0))
    # neck/head: stabilised against torso yaw/roll, lagging bob
    setrot('neck_01', (D(1.5) + D(1.0)*math.cos(4*math.pi*(p-0.05-0.12)), D(2.5)*sn(p, 0.55+0.1), -D(3.5)*sn(p, 0.12)))
    setrot('head', (D(0.8)*math.cos(4*math.pi*(p-0.05-0.2)) - D(1.0), D(2.0)*sn(p, 0.55+0.18), -D(3.0)*sn(p, 0.2)))
    # ---- IK helper bones follow their targets
    bpy.context.view_layer.update()
    bpy.context.evaluated_depsgraph_get().update()
    for ik, tgt in (('ik_foot_l', 'foot_l'), ('ik_foot_r', 'foot_r'), ('ik_hand_gun', 'hand_r')):
        pb[ik].matrix = pb[tgt].matrix.copy()
        bpy.context.view_layer.update()
    for ik, tgt in (('ik_hand_l', 'hand_l'), ('ik_hand_r', 'hand_r')):
        pb[ik].matrix = pb[tgt].matrix.copy()
        bpy.context.view_layer.update()

act = bpy.data.actions.new('Walk_Fwd_Loop')
arm.animation_data_create().action = act
bpy.context.scene.render.fps = FPS
bpy.context.scene.frame_start, bpy.context.scene.frame_end = 0, N
feet_log = []
for fr in range(N + 1):
    bpy.context.scene.frame_set(fr)
    pose_frame(fr % N)
    for pbn in pb:
        pbn.keyframe_insert('location', frame=fr, group=pbn.name)
        pbn.keyframe_insert('rotation_quaternion', frame=fr, group=pbn.name)
    feet_log.append((fr, pb['foot_l'].matrix.translation[:], pb['foot_r'].matrix.translation[:]))
os.makedirs(OUT, exist_ok=True)
import json; json.dump(feet_log, open(os.path.join(OUT, 'feet_log.json'), 'w'))
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.select_all(action='SELECT')
kw = dict(use_selection=True, object_types={'ARMATURE', 'MESH'}, add_leaf_bones=False, bake_anim=True,
          bake_anim_use_all_bones=True, bake_anim_use_nla_strips=False, bake_anim_use_all_actions=False,
          bake_anim_force_startend_keying=True, bake_anim_step=1.0, bake_anim_simplify_factor=0.0,
          primary_bone_axis='Y', secondary_bone_axis='X', armature_nodetype='NULL',
          apply_scale_options='FBX_SCALE_ALL', axis_forward='-Z', axis_up='Y', path_mode='COPY', embed_textures=False)
bpy.ops.export_scene.fbx(filepath=os.path.join(OUT, 'Walk_Fwd_Loop.fbx'), **kw)
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'Walk_Fwd_Loop.glb'), export_format='GLB',
                          export_animations=True, export_frame_range=True, export_yup=True)
