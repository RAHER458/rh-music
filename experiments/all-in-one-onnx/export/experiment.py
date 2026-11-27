import os, sys, json, subprocess, time, traceback
from pathlib import Path
ROOT=Path('/kaggle/working/allinone-exp'); ROOT.mkdir(parents=True, exist_ok=True)
OUT={}
def sh(cmd, cwd=None, check=False):
    print('+',' '.join(cmd), flush=True)
    p=subprocess.run(cmd,cwd=cwd,text=True,capture_output=True)
    print(p.stdout[-3000:], flush=True); print(p.stderr[-3000:], flush=True)
    if check and p.returncode: raise SystemExit(p.returncode)
    return p
# Clone
repo=ROOT/'all-in-one'
if not repo.exists():
    sh(['git','clone','--depth','1','https://github.com/mir-aidj/all-in-one.git',str(repo)],check=True)
# Selective deps (Kaggle already has torch/numpy/librosa/soundfile)
sh([sys.executable,'-m','pip','install','-q','onnx','onnxruntime','omegaconf','hydra-core','huggingface_hub','einops','torchaudio','librosa','soundfile','natten==0.17.5'],cwd=repo)
# Avoid importing the CLI/analysis package: it requires madmom just for construction.
(repo/'src/allin1/__init__.py').write_text('__version__ = "0.0.0"\n')
sys.path.insert(0,str(repo/'src'))
import torch, numpy as np
from omegaconf import OmegaConf
from allin1.models.allinone import AllInOne
import urllib.request, hashlib
ckpt_url='https://huggingface.co/taejunkim/allinone/resolve/main/harmonix-fold0-0vra4ys2.pth?download=true'
ckpt_path=ROOT/'harmonix-fold0.pth'
if not ckpt_path.exists():
    req=urllib.request.Request(ckpt_url,headers={'User-Agent':'Mozilla/5.0'})
    with urllib.request.urlopen(req,timeout=120) as r, open(ckpt_path,'wb') as f: f.write(r.read())
OUT['checkpoint_bytes']=ckpt_path.stat().st_size
OUT['checkpoint_sha256']=hashlib.sha256(ckpt_path.read_bytes()).hexdigest()
ckpt=torch.load(ckpt_path,map_location='cpu',weights_only=False)
cfg=OmegaConf.create(ckpt['config'])
model=AllInOne(cfg); model.load_state_dict(ckpt['state_dict']); model.eval()
OUT['config']={'depth':cfg.depth,'dim_embed':cfg.dim_embed,'num_instruments':cfg.data.num_instruments,'num_labels':cfg.data.num_labels,'sample_rate':cfg.data.sample_rate if 'sample_rate' in cfg.data else None}
# Official spectrogram is [K,T,81]; use T=128 for export. Dynamic T.
class Wrapper(torch.nn.Module):
    def __init__(self,m): super().__init__(); self.m=m
    def forward(self,x):
        o=self.m(x)
        return o.logits_beat,o.logits_downbeat,o.logits_section,o.logits_function,o.embeddings
wrapper=Wrapper(model)
dummy=torch.randn(1,int(cfg.data.num_instruments),128,81)
onnx_path=ROOT/'allinone_fold0.onnx'
try:
    torch.onnx.export(wrapper,dummy,str(onnx_path),input_names=['spec'],output_names=['beat','downbeat','section','function','embedding'],dynamic_axes={'spec':{2:'T'},'beat':{2:'T'},'downbeat':{2:'T'},'section':{2:'T'},'function':{3:'T'},'embedding':{2:'T'}},opset_version=17,do_constant_folding=True)
    OUT['export']={'ok':True,'bytes':onnx_path.stat().st_size,'sha256':hashlib.sha256(onnx_path.read_bytes()).hexdigest()}
except Exception as e:
    OUT['export']={'ok':False,'error':str(e),'trace':traceback.format_exc()[-2000:]}
if OUT.get('export',{}).get('ok'):
    import onnxruntime as ort
    sess=ort.InferenceSession(str(onnx_path),providers=['CPUExecutionProvider'])
    inp={sess.get_inputs()[0].name: dummy.numpy()}
    t0=time.time(); onnx_out=sess.run(None,inp); onnx_ms=(time.time()-t0)*1000
    with torch.no_grad(): torch_out=wrapper(dummy)
    def stats(a,b):
        a=np.asarray(a); b=np.asarray(b); d=np.abs(a-b)
        return {'shape':list(a.shape),'mae':float(d.mean()),'rmse':float(np.sqrt((d*d).mean())),'max_abs':float(d.max()),'cosine':float((a.ravel()@b.ravel())/(np.linalg.norm(a)*np.linalg.norm(b)+1e-12))}
    OUT['compare']={name:stats(t.numpy(),o) for name,t,o in zip(['beat','downbeat','section','function','embedding'],torch_out,onnx_out)}
    OUT['onnx_latency_ms']=onnx_ms
    OUT['onnx_inputs']=[{'name':i.name,'shape':i.shape,'type':i.type} for i in sess.get_inputs()]
    OUT['onnx_outputs']=[{'name':o.name,'shape':o.shape,'type':o.type} for o in sess.get_outputs()]
# HTDemucs feasibility: try install and run on 10s audio
try:
    import demucs
    OUT['demucs_import']=True
except Exception as e:
    OUT['demucs_import']=False; OUT['demucs_error']=str(e)
# madmom feasibility
try:
    import madmom
    OUT['madmom_import']=True
except Exception as e:
    OUT['madmom_import']=False; OUT['madmom_error']=str(e)
(ROOT/'result.json').write_text(json.dumps(OUT,ensure_ascii=False,indent=2))
Path('/kaggle/working/allinone-result.json').write_text(json.dumps(OUT,ensure_ascii=False,indent=2))
print('RESULT',json.dumps(OUT,ensure_ascii=False)[:4000])
