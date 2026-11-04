"""Create or verify the distributable source ZIP, excluding local runtime data."""

import argparse
import json
import os
from pathlib import Path
import re
import tempfile
from zipfile import ZipFile, ZIP_DEFLATED


ROOT = Path(__file__).resolve().parents[1]
FOLDERS = ('src', 'electron', 'browser-extension', 'bridges', 'tests', 'docs', 'scripts', 'build')
FILES = (
    '.gitignore', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'tsconfig.json', 'vite.config.ts', 'index.html',
    'gateway.config.example.json', 'gemini.config.example.json', 'universal-web2api.config.example.json',
    'README.md', 'LICENSE', 'THIRD_PARTY.md', 'THIRD_PARTY_LICENSES.txt',
)
EXCLUDED_NAMES = {
    '__pycache__', '.git', '.data', '.downloads', '.venv', 'venv',
    'node_modules', 'release', 'dist', 'artifacts',
    'cookie.txt', 'cookies.txt', 'cookies.json', 'state.json',
    'bridge-runtime.json', 'credentials.json', 'auth.json', 'config.json',
}
EXCLUDED_SUFFIXES = {'.log', '.pyc', '.pyo', '.pem', '.key', '.p12', '.pfx'}
PREFIX = 'Gravity/'


def excluded(relative):
    """Inspect names only; never read or include known credential/runtime files."""
    return any(
        part.lower() in EXCLUDED_NAMES
        or part.lower().startswith('.env')
        or Path(part).suffix.lower() in EXCLUDED_SUFFIXES
        for part in relative.parts
    )


def source_inventory(root=ROOT):
    result = {}

    def add(file):
        relative = file.relative_to(root)
        if excluded(relative):
            return
        # A symlink or junction must not pull files from outside the curated tree.
        if file.is_symlink() or file.resolve() != file.absolute():
            raise ValueError(f'Symlink or redirected source path: {relative}')
        if not file.is_file():
            raise ValueError(f'Required source file is missing: {relative}')
        result[PREFIX + relative.as_posix()] = file

    for name in FILES:
        add(root / name)
    for name in FOLDERS:
        directory = root / name
        if not directory.is_dir() or directory.is_symlink() or directory.resolve() != directory.absolute():
            raise ValueError(f'Required source directory is missing or redirected: {name}')
        # Prune excluded directories before traversing; os.walk does not follow links.
        for current, directories, filenames in os.walk(directory, followlinks=False):
            current = Path(current)
            directories[:] = sorted(d for d in directories if not excluded((current / d).relative_to(root)))
            for child in directories:
                directory_path = current / child
                if directory_path.is_symlink() or directory_path.resolve() != directory_path.absolute():
                    raise ValueError(f'Symlink or redirected source directory: {directory_path.relative_to(root)}')
            for filename in sorted(filenames):
                add(current / filename)
    return dict(sorted(result.items()))


def verify_archive(destination, inventory):
    with ZipFile(destination, 'r') as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(names) != len(set(name.casefold() for name in names)):
            raise ValueError('Source ZIP contains duplicate or case-colliding paths')
        if set(names) != set(inventory):
            missing = sorted(set(inventory) - set(names))
            unexpected = sorted(set(names) - set(inventory))
            raise ValueError(f'Source ZIP inventory differs (missing: {missing}; unexpected: {unexpected})')
        for entry in entries:
            if entry.is_dir() or entry.flag_bits & 1:
                raise ValueError(f'Unexpected directory or encrypted ZIP entry: {entry.filename}')
            if archive.read(entry) != inventory[entry.filename].read_bytes():
                raise ValueError(f'Source ZIP content differs: {entry.filename}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--verify-only', action='store_true', help='Verify the existing ZIP without rewriting it.')
    modes.add_argument('--check-inputs', action='store_true', help='Validate the source inventory without creating a ZIP.')
    args = parser.parse_args()
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', version):
        raise ValueError('package.json must contain a filename-safe semantic version')
    inventory = source_inventory()
    destination = ROOT / 'release' / f'Gravity-{version}-source.zip'
    if args.check_inputs:
        print(f'PASS: {len(inventory)} source files validated; credential and runtime paths excluded.')
        return
    if args.verify_only:
        verify_archive(destination, inventory)
        print(f'PASS: source ZIP matches all {len(inventory)} current source files.')
        return
    destination.parent.mkdir(exist_ok=True)
    # Validate before replacing a prior artifact; a failed run leaves it intact.
    descriptor, temporary_name = tempfile.mkstemp(prefix='.source-', suffix='.zip', dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with ZipFile(temporary, 'w', ZIP_DEFLATED, compresslevel=6) as archive:
            for name, file in inventory.items():
                archive.write(file, name)
        verify_archive(temporary, inventory)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    print(destination)


if __name__ == '__main__':
    main()
