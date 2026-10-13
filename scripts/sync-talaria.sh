#!/bin/bash
# Bring Talaria up to date on a Mac whose Hermes Desktop connects to a remote backend: pull
# hermes-talaria into ~/Documents/Github Repos/hermes-talaria (cloning it if missing), copy the device half
# into Hermes Desktop's plugin folder, and refresh the background helper if it is installed. The backend
# half lives on the server and is not touched.
#
#   sync-talaria                       from main
#   sync-talaria claude/project-thread-ekvwk9
#                                      a branch that is not merged yet
#   sync-talaria --install             also put this script on your PATH as sync-talaria, and the
#                                      helper as talaria-helper
#
# A checkout with changes that are not committed is left alone, so nothing of yours is overwritten.

ROOT="${GITHUB_REPOS:-$HOME/Documents/Github Repos}"
HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
URL="https://github.com/Kaylachuuu/hermes-talaria.git"
INSTALL=""
BRANCH="main"
for arg in "$@"; do
    case "$arg" in
        --install) INSTALL=1 ;;
        -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) BRANCH="$arg" ;;
    esac
done

command -v git >/dev/null || { echo "Stopped: git is not installed (xcode-select --install)."; exit 1; }
[ -d "$ROOT" ] || { echo "Stopped: no folder at $ROOT."; exit 1; }

if [ -n "$INSTALL" ]; then
    # Next to sync-repos if it is installed, else Homebrew's bin, which is on the PATH and needs no sudo.
    existing="$(command -v sync-repos 2>/dev/null)"
    if [ -n "$existing" ]; then BIN="$(dirname "$existing")"
    elif [ -d /opt/homebrew/bin ]; then BIN=/opt/homebrew/bin
    else BIN=/usr/local/bin; fi
    if install -m 755 "$0" "$BIN/sync-talaria" 2>/dev/null || sudo install -m 755 "$0" "$BIN/sync-talaria"; then
        echo "Installed as $BIN/sync-talaria"
    else
        echo "Stopped: could not write to $BIN."; exit 1
    fi
fi

# Github Repos/hermes-talaria, or an older checkout at Github Repos/hermes/talaria if that is there.
FOLDER="$ROOT/hermes-talaria"
[ ! -d "$FOLDER" ] && [ -d "$ROOT/hermes/talaria/.git" ] && FOLDER="$ROOT/hermes/talaria"
mkdir -p "$(dirname "$FOLDER")"

if [ -n "$INSTALL" ]; then
    # A talaria-helper command too, running the helper from this checkout (for setup, status and so on).
    printf '#!/bin/sh\nexec node "%s/helper/talaria-helper.mjs" "$@"\n' "$FOLDER" > "$BIN/talaria-helper.tmp" 2>/dev/null ||
        printf '#!/bin/sh\nexec node "%s/helper/talaria-helper.mjs" "$@"\n' "$FOLDER" | sudo tee "$BIN/talaria-helper.tmp" >/dev/null
    { chmod 755 "$BIN/talaria-helper.tmp" && mv "$BIN/talaria-helper.tmp" "$BIN/talaria-helper"; } 2>/dev/null ||
        sudo sh -c "chmod 755 '$BIN/talaria-helper.tmp' && mv '$BIN/talaria-helper.tmp' '$BIN/talaria-helper'"
    echo "Installed as $BIN/talaria-helper"
fi

echo "== talaria ($BRANCH)"
if [ -d "$FOLDER/.git" ]; then
    if [ -n "$(git -C "$FOLDER" status --porcelain)" ]; then
        echo "Stopped: $FOLDER has changes that are not committed. Commit or put them aside first."
        exit 1
    fi
    git -C "$FOLDER" fetch -q origin "$BRANCH" &&
        git -C "$FOLDER" checkout -q "$BRANCH" &&
        git -C "$FOLDER" merge --ff-only -q "origin/$BRANCH" || {
            echo "Stopped: could not bring $FOLDER to origin/$BRANCH."
            exit 1
        }
elif [ -e "$FOLDER" ]; then
    echo "Stopped: $FOLDER exists but is not a git checkout. Rename it and run this again to clone a fresh one."
    exit 1
else
    git clone -q --branch "$BRANCH" "$URL" "$FOLDER" || { echo "Stopped: could not clone $URL."; exit 1; }
fi

version="$(sed -n 's/^version:[[:space:]]*//p' "$FOLDER/talaria/plugin.yaml" 2>/dev/null)"
echo "talaria ${version:-?} at $(git -C "$FOLDER" log -1 --format='%h %s')"

SOURCE="$FOLDER/talaria/desktop/plugin.js"
TARGET="$HOME_DIR/desktop-plugins/talaria"
[ -f "$SOURCE" ] || { echo "Stopped: $SOURCE is missing."; exit 1; }
if cmp -s "$SOURCE" "$TARGET/plugin.js"; then
    echo "Desktop plugin already current in $TARGET."
else
    mkdir -p "$TARGET" && cp "$SOURCE" "$TARGET/plugin.js" || { echo "Stopped: could not copy to $TARGET."; exit 1; }
    echo "Desktop plugin updated in $TARGET."
    echo "In Hermes Desktop, press Rescan in Capabilities > Plugins (or restart the app) to load it."
fi

# The background helper, if it was installed: it runs from its own copy, so refresh and restart it.
HELPER_SRC="$FOLDER/helper/talaria-helper.mjs"
HELPER_COPY="${TALARIA_HELPER_HOME:-$HOME/Library/Application Support/Talaria}/talaria-helper.mjs"
if [ -f "$HELPER_COPY" ] && [ -f "$HELPER_SRC" ] && ! cmp -s "$HELPER_SRC" "$HELPER_COPY"; then
    if command -v node >/dev/null && node "$HELPER_SRC" install >/dev/null; then
        echo "Background helper updated and restarted."
    else
        echo "Stopped: could not update the background helper (node \"$HELPER_SRC\" install)."
        exit 1
    fi
fi
