#!/bin/bash
# This fork's rules for an upstream merge (sync-upstream.yml). The fork carries only eDrive Live (apps/edrive2) and
# Cluster Info (apps/cluster_info) and Light Show (apps/light_show):
#   during a conflicted merge: eDrive Live is this fork's own (upstream folded it into eDrive), so its files
#   stay as here; a file this fork deleted that upstream changed stays deleted, and so does any other app's;
#   README.md takes upstream's text with this fork's note (readme-note.md) on top;
#   LICENSE stays this fork's (GPL-3.0-or-later), and upstream's LICENSE (its MIT license) goes to LICENSE-MIT;
#   --after (the merge committed): an app upstream added or brought back is taken out again, the fork's own
#   test workflow and Store manifest settings are kept, and the workflow for removed apps stays gone.
set -u
KEEP_APPS=' edrive2 cluster_info light_show '
HERE=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = "--after" ]; then
    for d in apps/*/; do
        a=$(basename "$d")
        case "$KEEP_APPS" in *" $a "*) continue;; esac
        git rm -rqf --ignore-unmatch "apps/$a" && rm -rf "apps/$a"
        echo "rule: removed apps/$a (this fork carries only$KEEP_APPS)"
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
                apps/edrive2/*|apps/cluster_info/*|apps/light_show/*) git checkout --ours -- "$path" && git add "$path"; echo "rule: kept this fork's $path";;
                apps/*) git rm -qf "$path" 2>/dev/null || true; echo "rule: dropped $path (an app this fork doesn't carry)";;
                .github/workflows/app-tests.yml) git checkout --ours -- "$path" && git add "$path"; echo "rule: kept this fork's $path (its own test list)";;
                LICENSE)
                    git checkout --ours -- LICENSE && git show MERGE_HEAD:LICENSE > LICENSE-MIT
                    git add LICENSE LICENSE-MIT; echo "rule: kept this fork's LICENSE (GPL-3.0-or-later); upstream's MIT license to LICENSE-MIT";;
                README.md)
                    git checkout --theirs -- README.md
                    { cat "$HERE/readme-note.md"; cat README.md; } > README.md.new && mv README.md.new README.md
                    git add README.md; echo "rule: README.md from upstream with this fork's note on top";;
            esac;;
    esac
done
