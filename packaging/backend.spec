# PyInstaller one-directory backend; bundled inside the Electron installer/ZIP.
from pathlib import Path
import sys
from PyInstaller.utils.hooks import copy_metadata
root = Path(SPECPATH).parent
notices = [(str(Path(sys.base_prefix) / 'LICENSE.txt'), 'licenses')]
notices += copy_metadata('psutil') + copy_metadata('websocket-client')
a = Analysis([str(root / 'python/adapter.py')], pathex=[str(root / 'python')],
             binaries=[], datas=[(str(root / 'scripts/Focus-Agent.ps1'), 'scripts')] + notices,
             hiddenimports=[], hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=[])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='PulsarBackend',
          debug=False, bootloader_ignore_signals=False, strip=False, upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='PulsarBackend')
