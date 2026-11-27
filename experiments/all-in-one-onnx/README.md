# All-In-One ONNX Feasibility Experiment

Branch: `all-in-one-onnx-feasibility`
Base: `244240f`

Status: **INCOMPLETE / NO-GO for browser pipeline in the tested environment**.

The experiment attempted:
1. clone `mir-aidj/all-in-one` at `18e78903c0365147a2c5d4e5e57ebf88cb7d800e`;
2. install official dependencies;
3. load the MIT `harmonix-fold0` checkpoint from `taejunkim/allinone`;
4. export one fold to ONNX;
5. compare PyTorch/ONNX;
6. inspect HTDemucs/madmom feasibility.

It stopped before export because the official model import requires NATTEN. Kaggle's Python 3.13 image only had NATTEN 0.21.7 (`na1d`/`na2d` API), while All-In-One imports the removed `natten1dav`, `natten1dqkrpb`, `natten2dav`, `natten2dqkrpb` API. Installing NATTEN 0.14.6/0.17.5 from source failed to build on Python 3.13. No architecture rewrite or attention replacement was attempted, because that would change the model and invalidate the comparison.

The official pipeline additionally requires madmom and HTDemucs before the structure model. Neither was available as a verified browser component.
