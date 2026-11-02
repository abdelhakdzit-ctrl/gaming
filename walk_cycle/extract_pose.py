import cv2, json, sys, numpy as np, mediapipe as mp
cap = cv2.VideoCapture(sys.argv[1]); fps = cap.get(cv2.CAP_PROP_FPS)
pose = mp.solutions.pose.Pose(model_complexity=2, smooth_landmarks=True)
N = mp.solutions.pose.PoseLandmark
names = ['LEFT_SHOULDER','RIGHT_SHOULDER','LEFT_ELBOW','RIGHT_ELBOW','LEFT_WRIST','RIGHT_WRIST','LEFT_HIP','RIGHT_HIP','LEFT_KNEE','RIGHT_KNEE','LEFT_ANKLE','RIGHT_ANKLE','LEFT_FOOT_INDEX','RIGHT_FOOT_INDEX','NOSE']
out = []
while True:
    ok, f = cap.read()
    if not ok: break
    r = pose.process(cv2.cvtColor(f, cv2.COLOR_BGR2RGB))
    if r.pose_landmarks:
        h, w = f.shape[:2]
        out.append({n: [r.pose_landmarks.landmark[N[n]].x*w, r.pose_landmarks.landmark[N[n]].y*h, r.pose_landmarks.landmark[N[n]].visibility] for n in names})
    else: out.append(None)
json.dump({'fps': fps, 'frames': out}, open(sys.argv[2], 'w'))
print(len(out), 'frames', sum(o is None for o in out), 'missing')
