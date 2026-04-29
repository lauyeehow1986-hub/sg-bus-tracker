#!/usr/bin/env bash
# T1.4: Pre-commit sanity checks.
# Run from repo root:  ./scripts/check.sh
# Install as git hook:  ln -s ../../scripts/check.sh .git/hooks/pre-commit
#
# Blocks commits that contain:
#   - JS syntax errors (node --check)
#   - Python syntax errors in proxy.py (py_compile)
#   - Unresolvable imports across the JS modules
#   - JSON syntax errors in manifest.json
set -e
cd "$(dirname "$0")/.."

echo "→ Checking JS syntax..."
for f in js/*.js; do
  node --check "$f" > /dev/null
done

echo "→ Checking Python..."
python3 -m py_compile proxy.py

echo "→ Checking JSON..."
python3 -c "import json; json.load(open('manifest.json'))"

echo "→ Checking JS imports resolve..."
python3 <<'PY'
import re, glob, sys
exports = {}
for p in glob.glob('js/*.js'):
    src = open(p).read()
    exp = set()
    for m in re.finditer(r'^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)', src, re.M):
        exp.add(m.group(1))
    for m in re.finditer(r'^export\s*\{([^}]+)\}', src, re.M):
        for name in m.group(1).split(','):
            exp.add(name.strip().split(' as ')[0].strip())
    exports[p.split('/')[-1]] = exp

errors = []
for p in glob.glob('js/*.js'):
    src = open(p).read()
    for m in re.finditer(r"import\s+(?:\*\s+as\s+[\w$]+|\{([^}]+)\}|[\w$]+)\s+from\s+['\"]([^'\"]+)['\"]", src, re.S):
        named, src_path = m.groups()
        if not named:
            continue
        target = src_path.lstrip('./')
        if target not in exports:
            errors.append(f"{p}: unknown module {src_path}")
            continue
        for n in named.split(','):
            n = n.strip().split(' as ')[0].strip()
            if n and n not in exports[target]:
                errors.append(f"{p}: {n!r} not exported by {src_path}")

if errors:
    for e in errors: print("  ✗ " + e, file=sys.stderr)
    sys.exit(1)
PY

echo "✓ All checks passed."
