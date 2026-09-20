"""Bundle sources plus prebuilt extensions; run after scripts/build.mjs."""
import os, shutil, tempfile, zipfile
from pathlib import Path
root = Path(__file__).resolve().parent.parent
dist = Path(os.environ.get('PRIVEXA_DIST', root / 'dist'))
output = Path(os.environ.get('PRIVEXA_ZIP', root.parent / 'Privexa-Local-SIH26171.zip'))
with tempfile.TemporaryDirectory() as temp:
    staged = Path(temp) / 'Privexa-Local-SIH26171.zip'
    with zipfile.ZipFile(staged, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(root.rglob('*')):
            rel = p.relative_to(root)
            if not p.is_file() or any(part in {'node_modules','.venv','__pycache__','.pytest_cache','dist','.git'} for part in rel.parts): continue
            z.write(p, Path('privexa-local') / rel)
        for p in sorted(dist.rglob('*')):
            if p.is_file(): z.write(p, Path('privexa-local/dist') / p.relative_to(dist))
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(staged, output)
print(output)
