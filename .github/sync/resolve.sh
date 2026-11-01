#!/bin/bash
# This fork's rules for an upstream merge (sync-upstream.yml). The fork carries only eDrive Live (apps/edrive2):
#   during a conflicted merge: a file this fork deleted that upstream changed stays deleted, and so does any
#   other app's file;
#   --after: an app upstream added or brought back is taken out again.
set -u
KEEP_APP=edrive2
if [ "${1:-}" = "--after" ]; then
    for d in apps/*/; do
        a=$(basename "$d")
        [ "$a" = "$KEEP_APP" ] && continue
        git rm -rqf --ignore-unmatch "apps/$a" && rm -rf "apps/$a"
        echo "rule: removed apps/$a (this fork carries only $KEEP_APP)"
    done
    exit 0
fi
git status --porcelain | while read -r code path; do
    case "$code" in
        DU) git rm -qf "$path"; echo "rule: kept deleted $path (deleted here, changed upstream)";;
        UU|AA|AU|UA|UD)
            case "$path" in
                apps/"$KEEP_APP"/*) ;;
                apps/*) git rm -qf "$path" 2>/dev/null || true; echo "rule: dropped $path (an app this fork doesn't carry)";;
            esac;;
    esac
done
