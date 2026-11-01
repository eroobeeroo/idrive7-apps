#!/bin/bash
# This fork's rules for an upstream merge (sync-upstream.yml). The fork carries only eDrive Live (apps/edrive2):
#   during a conflicted merge: eDrive Live is this fork's own (upstream folded it into eDrive), so its files
#   stay as here; a file this fork deleted that upstream changed stays deleted, and so does any other app's;
#   README.md takes upstream's text with this fork's note (readme-note.md) on top;
#   --after (the merge committed): an app upstream added or brought back is taken out again, the fork's own
#   test workflow and Store manifest settings are kept, and the workflow for removed apps stays gone.
set -u
KEEP_APP=edrive2
HERE=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = "--after" ]; then
    for d in apps/*/; do
        a=$(basename "$d")
        [ "$a" = "$KEEP_APP" ] && continue
        git rm -rqf --ignore-unmatch "apps/$a" && rm -rf "apps/$a"
        echo "rule: removed apps/$a (this fork carries only $KEEP_APP)"
    done
    # the fork's own test list (upstream's names tests of apps this fork doesn't carry)
    if git rev-parse -q --verify HEAD^2 >/dev/null; then
        git checkout HEAD^1 -- .github/workflows/app-tests.yml && echo "rule: kept this fork's app-tests.yml"
    fi
    git rm -qf --ignore-unmatch .github/workflows/experimental-apps.yml
    sed -i 's/"network": \[[^]]*\]/"network": []/' mgu-repo.json && git add mgu-repo.json
    exit 0
fi
git status --porcelain | while read -r code path; do
    case "$code" in
        DU) git rm -qf "$path"; echo "rule: kept deleted $path (deleted here, changed upstream)";;
        UU|AA|AU|UA|UD)
            case "$path" in
                apps/"$KEEP_APP"/*) git checkout --ours -- "$path" && git add "$path"; echo "rule: kept this fork's $path";;
                apps/*) git rm -qf "$path" 2>/dev/null || true; echo "rule: dropped $path (an app this fork doesn't carry)";;
                README.md)
                    git checkout --theirs -- README.md
                    { cat "$HERE/readme-note.md"; cat README.md; } > README.md.new && mv README.md.new README.md
                    git add README.md; echo "rule: README.md from upstream with this fork's note on top";;
            esac;;
    esac
done
