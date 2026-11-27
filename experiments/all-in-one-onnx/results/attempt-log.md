# Attempt log

## Official import

```
from allin1.models.allinone import AllInOne
ModuleNotFoundError: No module named 'madmom'
```

The package `__init__` imports the CLI/analysis module, which imports madmom. The experiment removed that `__init__` side effect for model-only testing; this is documented and does not alter the model.

## NATTEN 0.21.7

```
ImportError: cannot import name 'natten1dav' from 'natten.functional'
```

`dir(natten.functional)` returned `['na1d', 'na2d', 'na3d', 'na_tensor_checks']`; the old qk/av API has been removed.

## NATTEN 0.14.6 / 0.17.5

```
ERROR: Failed to build 'natten' when getting requirements to build wheel
```

No prebuilt wheel for the Kaggle Python 3.13 environment was available.

No export, no ONNX runtime comparison, no full pipeline result.
