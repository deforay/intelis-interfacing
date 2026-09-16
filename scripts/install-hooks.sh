#!/usr/bin/env bash
#
# Install repo git hooks by symlinking .git/hooks/<name> -> scripts/hooks/<name>.
# Run once per clone:  npm run install-hooks
#
# Best-effort by design: never fails, so it stays safe to call from an npm
# lifecycle script or a setup step where a hard failure would abort the run.
# Any problem -> warn and exit 0. A clean no-op outside a git checkout.
#
# NOTE: targets `git rev-parse --git-common-dir`/hooks -- the literal repo hooks
# directory -- NOT `--git-path hooks`, which honours core.hooksPath and would
# write into a globally configured hooks directory instead of this repo's.
#
# A global core.hooksPath does not stop these from running, provided the global
# dispatcher delegates to the repo-local hook of the same name. If yours does
# not, it will shadow these; point core.hooksPath at this directory instead.
set -u

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" || exit 0

hooks_dir="$(git rev-parse --git-common-dir 2>/dev/null)/hooks"
mkdir -p "$hooks_dir" 2>/dev/null || {
    echo "install-hooks: cannot create $hooks_dir - skipping (non-fatal)." >&2
    exit 0
}

for src in scripts/hooks/*; do
    [[ -e "$src" ]] || continue
    name="$(basename "$src")"
    chmod +x "$src" 2>/dev/null || true
    if ln -sf "$root/scripts/hooks/$name" "$hooks_dir/$name" 2>/dev/null; then
        echo "installed $name -> $hooks_dir/$name"
    else
        echo "install-hooks: could not link $name - skipping (non-fatal)." >&2
    fi
done

exit 0
