"""Chrome ウェブストア用 ZIP を明示した配布ファイルだけで作る。"""
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'manifest.json').read_text())
files = ['manifest.json', 'background.js', 'content.js', 'canvas-bridge.js',
         'preview.js', 'popup.html', 'popup.js', 'privacy.html', *manifest['icons'].values()]
assert len(files) == len(set(files))
for file in files:
    assert (root / file).is_file(), file
output = root / 'dist' / f'MornGeminiRelay-{manifest["version"]}.zip'
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for file in files:
        archive.write(root / file, file)
with ZipFile(output) as archive:
    assert set(archive.namelist()) == set(files)
    assert archive.testzip() is None
print(output)
